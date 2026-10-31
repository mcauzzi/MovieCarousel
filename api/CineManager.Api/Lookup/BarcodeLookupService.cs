using System.Text.Json;
using CineManager.Api.Data;
using CineManager.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace CineManager.Api.Lookup;

public sealed record BarcodeLookupResult(string? ProductName, string? Provider, bool FromCache);

/// <summary>
/// Catena dei provider (<c>Lookup__Providers</c>, il primo che trova vince) con cache in
/// <c>ean_lookup_cache</c>: 30 giorni per i trovati, 24 ore per i "non trovato". Gli errori
/// temporanei dei provider non vengono messi in cache.
/// </summary>
public sealed class BarcodeLookupService(
    CinemaDbContext db, IEnumerable<IBarcodeProvider> providers, IOptions<LookupOptions> options,
    TimeProvider clock, ILogger<BarcodeLookupService> log)
{
    public static readonly TimeSpan FoundTtl = TimeSpan.FromDays(30);
    public static readonly TimeSpan NotFoundTtl = TimeSpan.FromHours(24);
    public const string NotFoundProvider = "none";

    private sealed record CachedResponse(bool Found, string? Title);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task<BarcodeLookupResult> LookupAsync(string ean, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var cached = await db.EanLookupCache.FirstOrDefaultAsync(c => c.Ean == ean, ct);
        if (cached is not null)
        {
            var resp = TryRead(cached.Response);
            var age = now - cached.FetchedAt;
            if (resp is { Found: true } && age < FoundTtl) return new(resp.Title, cached.Provider, true);
            if (resp is { Found: false } && age < NotFoundTtl) return new(null, null, true);
        }

        var anyError = false;
        foreach (var provider in Chain())
        {
            try
            {
                var r = await provider.LookupAsync(ean, ct);
                if (!r.Found) continue;
                await StoreAsync(cached, ean, provider.Name, new CachedResponse(true, r.ProductName), now, ct);
                return new(r.ProductName, provider.Name, false);
            }
            catch (Exception ex) when (ex is BarcodeProviderException or HttpRequestException
                                           || (ex is TaskCanceledException && !ct.IsCancellationRequested))
            {
                anyError = true;
                log.LogWarning(ex, "Provider {Provider}: ricerca EAN {Ean} non riuscita", provider.Name, ean);
            }
        }
        if (!anyError) await StoreAsync(cached, ean, NotFoundProvider, new CachedResponse(false, null), now, ct);
        return new(null, null, false);
    }

    /// <summary>Provider nell'ordine di configurazione; i nomi sconosciuti vengono ignorati (con un avviso).</summary>
    private IEnumerable<IBarcodeProvider> Chain()
    {
        var byName = providers.GroupBy(p => p.Name, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.Last(), StringComparer.OrdinalIgnoreCase);
        foreach (var name in options.Value.Providers.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (byName.TryGetValue(name, out var p)) yield return p;
            else log.LogWarning("Lookup__Providers: provider sconosciuto '{Name}'", name);
        }
    }

    private async Task StoreAsync(EanLookupCache? row, string ean, string provider, CachedResponse resp,
        DateTimeOffset now, CancellationToken ct)
    {
        if (row is null)
        {
            row = new EanLookupCache { Ean = ean };
            db.EanLookupCache.Add(row);
        }
        row.Provider = provider;
        row.Response = JsonSerializer.Serialize(resp, Json);
        row.FetchedAt = now;
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException ex)
        {
            // Due ricerche simultanee dello stesso EAN: basta una delle due righe.
            log.LogDebug(ex, "Cache EAN {Ean} non salvata", ean);
            db.ChangeTracker.Clear();
        }
    }

    private static CachedResponse? TryRead(string json)
    {
        try { return JsonSerializer.Deserialize<CachedResponse>(json, Json); }
        catch (JsonException) { return null; }
    }
}
