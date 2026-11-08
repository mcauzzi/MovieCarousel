using System.Net;
using System.Text.Json;
using CineManager.Api.Infrastructure;
using Microsoft.Extensions.Options;

namespace CineManager.Api.Lookup;

/// <summary>Esito di un provider: <see cref="ProductName"/> null = codice sconosciuto al provider.</summary>
public sealed record BarcodeProviderResult(string? ProductName)
{
    public static readonly BarcodeProviderResult NotFound = new((string?)null);
    public bool Found => !string.IsNullOrWhiteSpace(ProductName);
}

/// <summary>Errore temporaneo del provider (quota, rete, risposta inattesa): l'esito non va in cache.</summary>
public sealed class BarcodeProviderException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>Database di codici a barre: EAN → nome del prodotto (§7, passo 1).</summary>
public interface IBarcodeProvider
{
    /// <summary>Nome usato in <c>Lookup__Providers</c> e salvato in <c>ean_lookup_cache.provider</c>.</summary>
    string Name { get; }

    Task<BarcodeProviderResult> LookupAsync(string ean, CancellationToken ct);
}

/// <summary>
/// UPCitemdb: endpoint di prova gratuito (quota giornaliera per IP) oppure, con
/// <c>Lookup__UpcItemDbKey</c>, l'endpoint a pagamento con gli header <c>user_key</c>/<c>key_type</c>.
/// </summary>
public sealed class UpcItemDbProvider(HttpClient http, IOptions<LookupOptions> options) : IBarcodeProvider
{
    public const string ProviderName = "upcitemdb";
    public const string TrialUrl = "https://api.upcitemdb.com/prod/trial/lookup";
    public const string PaidUrl = "https://api.upcitemdb.com/prod/v1/lookup";

    public string Name => ProviderName;

    public async Task<BarcodeProviderResult> LookupAsync(string ean, CancellationToken ct)
    {
        var key = options.Value.UpcItemDbKey?.Trim();
        var url = (string.IsNullOrEmpty(key) ? TrialUrl : PaidUrl) + "?upc=" + Uri.EscapeDataString(ean);
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Accept.ParseAdd("application/json");
        if (!string.IsNullOrEmpty(key))
        {
            req.Headers.TryAddWithoutValidation("user_key", key);
            req.Headers.TryAddWithoutValidation("key_type", "3scale");
        }

        HttpResponseMessage res;
        try { res = await http.SendAsync(req, ct); }
        catch (HttpRequestException ex) { throw new BarcodeProviderException("UPCitemdb non raggiungibile.", ex); }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested) { throw new BarcodeProviderException("UPCitemdb: timeout.", ex); }

        using (res)
        {
            var body = await res.Content.ReadAsStringAsync(ct);
            if (res.StatusCode == HttpStatusCode.NotFound) return BarcodeProviderResult.NotFound;
            if (res.StatusCode == HttpStatusCode.BadRequest && body.Contains("INVALID_UPC", StringComparison.OrdinalIgnoreCase))
                return BarcodeProviderResult.NotFound;
            if (res.StatusCode == HttpStatusCode.TooManyRequests)
                throw new BarcodeProviderException("UPCitemdb: quota esaurita.");
            if (!res.IsSuccessStatusCode)
                throw new BarcodeProviderException($"UPCitemdb: stato HTTP {(int)res.StatusCode}.");
            try
            {
                using var doc = JsonDocument.Parse(body);
                if (!doc.RootElement.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array)
                    return BarcodeProviderResult.NotFound;
                foreach (var item in items.EnumerateArray())
                    if (item.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String &&
                        !string.IsNullOrWhiteSpace(t.GetString()))
                        return new BarcodeProviderResult(t.GetString()!.Trim());
                return BarcodeProviderResult.NotFound;
            }
            catch (JsonException ex) { throw new BarcodeProviderException("UPCitemdb: risposta non valida.", ex); }
        }
    }
}
