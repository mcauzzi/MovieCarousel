using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;
using CineManager.Api.Infrastructure;
using Microsoft.Extensions.Options;

namespace CineManager.Api.Lookup;

/// <summary>TMDb non configurato (<c>Tmdb__ApiToken</c> vuoto).</summary>
public sealed class TmdbUnavailableException() : Exception("Tmdb__ApiToken non configurato.");

/// <summary>Errore di TMDb (rete, stato HTTP, risposta non valida).</summary>
public sealed class TmdbException(string message, Exception? inner = null) : Exception(message, inner);

public sealed record TmdbSearchHit(int Id, string Title, string? OriginalTitle, int? Year, string? PosterPath);

public sealed class TmdbMovie
{
    public int Id { get; set; }
    public string? Title { get; set; }
    public string? OriginalTitle { get; set; }
    public string? ReleaseDate { get; set; }
    public int? Runtime { get; set; }
    public string? Overview { get; set; }
    public string? PosterPath { get; set; }
    public List<TmdbNamed> Genres { get; set; } = [];
    public List<TmdbCountry> ProductionCountries { get; set; } = [];
    public List<TmdbLanguage> SpokenLanguages { get; set; } = [];
    public TmdbCredits? Credits { get; set; }
}

public sealed class TmdbNamed { public string? Name { get; set; } }

public sealed class TmdbCountry
{
    [JsonPropertyName("iso_3166_1")] public string? Iso { get; set; }
    public string? Name { get; set; }
}

public sealed class TmdbLanguage
{
    [JsonPropertyName("iso_639_1")] public string? Iso { get; set; }
    public string? EnglishName { get; set; }
    public string? Name { get; set; }
}

public sealed class TmdbCredits
{
    public List<TmdbCast> Cast { get; set; } = [];
    public List<TmdbCrew> Crew { get; set; } = [];
}

public sealed class TmdbCast
{
    public string? Name { get; set; }
    public string? Character { get; set; }
    public int Order { get; set; }
}

public sealed class TmdbCrew
{
    public string? Name { get; set; }
    public string? Job { get; set; }
}

/// <summary>
/// Client TMDb v3 con token v4 (bearer): <c>search/movie</c> e
/// <c>movie/{id}?append_to_response=credits</c>, sempre con <c>language=it-IT</c>.
/// </summary>
public sealed class TmdbClient(HttpClient http, IOptions<TmdbOptions> options)
{
    public const string BaseUrl = "https://api.themoviedb.org/3/";
    public const string ImageBase = "https://image.tmdb.org/t/p/";

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        PropertyNameCaseInsensitive = true,
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
    };

    public bool Configured => !string.IsNullOrWhiteSpace(options.Value.ApiToken);

    public async Task<List<TmdbSearchHit>> SearchAsync(string query, int? year, CancellationToken ct)
    {
        var url = "search/movie?query=" + Uri.EscapeDataString(query) +
                  "&language=it-IT&region=IT&include_adult=false&page=1" +
                  (year is { } y ? "&year=" + y.ToString(CultureInfo.InvariantCulture) : "");
        using var doc = await GetAsync(url, ct) ?? throw new TmdbException("search/movie: 404");
        var hits = new List<TmdbSearchHit>();
        if (!doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array)
            return hits;
        foreach (var r in results.EnumerateArray())
        {
            if (!r.TryGetProperty("id", out var idEl) || !idEl.TryGetInt32(out var id)) continue;
            var title = Str(r, "title") ?? Str(r, "original_title") ?? "";
            hits.Add(new TmdbSearchHit(id, title, Str(r, "original_title"), YearOf(Str(r, "release_date")), Str(r, "poster_path")));
        }
        return hits;
    }

    /// <summary>Dettagli con i crediti; null se TMDb non conosce l'id.</summary>
    public async Task<TmdbMovie?> GetMovieAsync(int tmdbId, CancellationToken ct)
    {
        using var doc = await GetAsync($"movie/{tmdbId.ToString(CultureInfo.InvariantCulture)}?language=it-IT&append_to_response=credits", ct);
        if (doc is null) return null;
        try { return doc.RootElement.Deserialize<TmdbMovie>(Json); }
        catch (JsonException ex) { throw new TmdbException("Risposta TMDb non valida.", ex); }
    }

    public static string? PosterUrl(string? posterPath, string size = "w185") =>
        string.IsNullOrEmpty(posterPath) ? null : ImageBase + size + posterPath;

    public static int? YearOf(string? date) =>
        date is { Length: >= 4 } && int.TryParse(date[..4], NumberStyles.None, CultureInfo.InvariantCulture, out var y) ? y : null;

    private async Task<JsonDocument?> GetAsync(string relative, CancellationToken ct)
    {
        var token = options.Value.ApiToken?.Trim();
        if (string.IsNullOrEmpty(token)) throw new TmdbUnavailableException();
        using var req = new HttpRequestMessage(HttpMethod.Get, new Uri(new Uri(BaseUrl), relative));
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.Accept.ParseAdd("application/json");
        try
        {
            using var res = await http.SendAsync(req, ct);
            if (res.StatusCode == HttpStatusCode.NotFound) return null;
            if (!res.IsSuccessStatusCode) throw new TmdbException($"TMDb: stato HTTP {(int)res.StatusCode}.");
            await using var stream = await res.Content.ReadAsStreamAsync(ct);
            return await JsonDocument.ParseAsync(stream, cancellationToken: ct);
        }
        catch (HttpRequestException ex) { throw new TmdbException("TMDb non raggiungibile.", ex); }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested) { throw new TmdbException("TMDb: timeout.", ex); }
        catch (JsonException ex) { throw new TmdbException("Risposta TMDb non valida.", ex); }
    }

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(v.GetString())
            ? v.GetString() : null;
}
