using System.Text.Json;
using CineManager.Api.Infrastructure;
using Microsoft.Extensions.Options;

namespace CineManager.Api.Devices;

/// <summary>
/// <c>minSupportedCode</c> dal <c>version.json</c> dell'immagine del sito (§11.1), per il
/// controllo 426. Cache di 5 minuti; se il file non è raggiungibile il controllo viene saltato
/// (e registrato nei log), riprovando dopo un minuto.
/// </summary>
public sealed class AppVersionProvider(
    IHttpClientFactory http, IOptions<AppOptions> options, TimeProvider clock, ILogger<AppVersionProvider> log)
{
    public const string HttpClientName = "app-version";
    private static readonly TimeSpan CacheFor = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan RetryAfterFailure = TimeSpan.FromMinutes(1);

    private readonly SemaphoreSlim _lock = new(1, 1);
    private int? _min;
    private DateTimeOffset _validUntil = DateTimeOffset.MinValue;

    /// <summary>Versione minima supportata; null se non configurata o non disponibile.</summary>
    public async Task<int?> GetMinSupportedCodeAsync(CancellationToken ct)
    {
        var url = options.Value.VersionUrl;
        if (string.IsNullOrWhiteSpace(url)) return null;
        if (clock.GetUtcNow() < _validUntil) return _min;

        await _lock.WaitAsync(ct);
        try
        {
            var now = clock.GetUtcNow();
            if (now < _validUntil) return _min;
            try
            {
                using var client = http.CreateClient(HttpClientName);
                using var res = await client.GetAsync(url, ct);
                res.EnsureSuccessStatusCode();
                await using var stream = await res.Content.ReadAsStreamAsync(ct);
                using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
                if (!doc.RootElement.TryGetProperty("minSupportedCode", out var el) || !el.TryGetInt32(out var min))
                    throw new FormatException("minSupportedCode mancante o non intero.");
                _min = min;
                _validUntil = now + CacheFor;
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or FormatException
                                           or InvalidOperationException)
            {
                if (ct.IsCancellationRequested) throw;
                log.LogWarning(ex, "version.json non disponibile ({Url}): controllo della versione minima saltato", url);
                _min = null;
                _validUntil = now + RetryAfterFailure;
            }
            return _min;
        }
        finally
        {
            _lock.Release();
        }
    }
}
