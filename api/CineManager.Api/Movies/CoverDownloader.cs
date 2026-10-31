using System.Net;
using System.Text.RegularExpressions;
using CineManager.Api.Import;

namespace CineManager.Api.Movies;

/// <summary>
/// Copertine degli arrivi dall'app (§7): solo da <c>https://image.tmdb.org/t/p/w500</c> (unico
/// host, niente SSRF), senza redirect automatici, content-type JPEG/PNG, al massimo 5 MB.
/// Salvate come <c>cm-&lt;id&gt;.jpg|png</c> in <c>Covers__Path</c> con scrittura atomica.
/// </summary>
public sealed partial class CoverDownloader(HttpClient http, CoverStore covers, ILogger<CoverDownloader> log)
{
    public const string BaseUrl = "https://image.tmdb.org/t/p/w500";
    public const long MaxBytes = 5L * 1024 * 1024;

    [GeneratedRegex("^/[A-Za-z0-9_-]+\\.(jpg|jpeg|png)$")]
    private static partial Regex PosterPathRegex();

    public static bool IsValidPosterPath(string? path) => path is not null && PosterPathRegex().IsMatch(path);

    /// <summary>Nome del file salvato, oppure null (errore registrato nei log: il film resta senza copertina).</summary>
    public async Task<string?> DownloadAsync(int movieId, string posterPath, CancellationToken ct)
    {
        if (!IsValidPosterPath(posterPath)) return null;
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, BaseUrl + posterPath);
            using var res = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
            if (res.StatusCode != HttpStatusCode.OK)
                return Fail(movieId, $"stato HTTP {(int)res.StatusCode}");
            var ext = res.Content.Headers.ContentType?.MediaType?.ToLowerInvariant() switch
            {
                "image/jpeg" or "image/jpg" => ".jpg",
                "image/png" => ".png",
                var other => null,
            };
            if (ext is null) return Fail(movieId, $"content-type non ammesso ({res.Content.Headers.ContentType?.MediaType ?? "assente"})");
            if (res.Content.Headers.ContentLength is > MaxBytes) return Fail(movieId, "oltre 5 MB");

            await using var stream = await res.Content.ReadAsStreamAsync(ct);
            using var ms = new MemoryStream();
            var buffer = new byte[64 * 1024];
            int n;
            while ((n = await stream.ReadAsync(buffer, ct)) > 0)
            {
                if (ms.Length + n > MaxBytes) return Fail(movieId, "oltre 5 MB");
                ms.Write(buffer, 0, n);
            }
            var bytes = ms.ToArray();
            if (!LooksLike(bytes, ext)) return Fail(movieId, "contenuto non corrispondente al content-type");

            var name = CoverStore.AppCoverName(movieId, ext);
            await covers.WriteAtomicAsync(name, bytes, ct);
            covers.DeleteAppCovers(movieId, keep: name);
            return name;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException or UnauthorizedAccessException
                                       && !ct.IsCancellationRequested)
        {
            log.LogWarning(ex, "Copertina del film {Id} non scaricata", movieId);
            return null;
        }
    }

    private static bool LooksLike(byte[] b, string ext) => ext == ".png"
        ? b.Length > 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47
        : b.Length > 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF;

    private string? Fail(int movieId, string reason)
    {
        log.LogWarning("Copertina del film {Id} non scaricata: {Reason}", movieId, reason);
        return null;
    }
}
