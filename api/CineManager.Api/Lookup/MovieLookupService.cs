using System.Text.Json.Nodes;
using CineManager.Api.Data;
using CineManager.Api.Movies;

namespace CineManager.Api.Lookup;

public sealed record LookupCandidate(int TmdbId, string Title, string? OriginalTitle, int? Year, string? PosterPath, string? PosterUrl);

/// <summary>
/// Risposta di <c>/api/app/lookup</c>. <c>TmdbAvailable</c> = false se TMDb non è configurato o non
/// ha risposto: la bozza viene allora solo dal nome prodotto e l'app può proporre di riprovare.
/// </summary>
public sealed record LookupResponse(
    string Ean, string? ProductName, int? TmdbId, string? PosterPath, string? PosterUrl, JsonObject Draft,
    IReadOnlyList<LookupCandidate> Candidates, IReadOnlyList<DuplicateCandidate> PossibleDuplicates,
    bool TmdbAvailable);

public sealed record TmdbDraftResponse(
    int TmdbId, string? PosterPath, string? PosterUrl, JsonObject Draft, IReadOnlyList<DuplicateCandidate> PossibleDuplicates);

/// <summary>Ricerca da codice a barre e su TMDb per l'app (§7).</summary>
public sealed class MovieLookupService(
    CinemaDbContext db, BarcodeLookupService barcodes, TmdbClient tmdb, ILogger<MovieLookupService> log)
{
    public const int MaxCandidates = 5;

    public async Task<LookupResponse> LookupAsync(string ean, CancellationToken ct)
    {
        var fields = await FieldCatalog.LoadAsync(db, ct);
        var product = await barcodes.LookupAsync(ean, ct);
        var draft = new JsonObject();
        var candidates = new List<LookupCandidate>();
        int? tmdbId = null;
        string? posterPath = null;
        var tmdbAvailable = tmdb.Configured;

        if (product.ProductName is { } name)
        {
            var cleaned = ProductTitleCleaner.Clean(name);
            if (cleaned.Title.Length > 0)
            {
                draft = TmdbMapper.ToDraft(new JsonObject { ["title"] = cleaned.Title, ["year"] = cleaned.Year }, fields);
                try
                {
                    candidates = await SearchAsync(cleaned.Title, cleaned.Year, ct);
                    if (candidates.Count > 0 && await tmdb.GetMovieAsync(candidates[0].TmdbId, ct) is { } best)
                    {
                        draft = TmdbMapper.ToDraft(TmdbMapper.FullDraft(best), fields);
                        tmdbId = best.Id;
                        posterPath = best.PosterPath;
                    }
                }
                catch (TmdbUnavailableException)
                {
                    tmdbAvailable = false;
                    log.LogWarning("Tmdb__ApiToken non configurato: bozza solo dal nome prodotto");
                }
                catch (TmdbException ex)
                {
                    tmdbAvailable = false;
                    log.LogWarning(ex, "Ricerca TMDb per l'EAN {Ean} non riuscita", ean);
                }
            }
        }

        var duplicates = await DuplicateFinder.FindAsync(db, draft, tmdbId, ean, ct);
        return new LookupResponse(ean, product.ProductName, tmdbId, posterPath, TmdbClient.PosterUrl(posterPath, "w500"),
            draft, candidates, duplicates, tmdbAvailable);
    }

    /// <summary>Candidati TMDb; con l'anno senza risultati riprova senza.</summary>
    public async Task<List<LookupCandidate>> SearchAsync(string query, int? year, CancellationToken ct)
    {
        var hits = await tmdb.SearchAsync(query, year, ct);
        if (hits.Count == 0 && year is not null) hits = await tmdb.SearchAsync(query, null, ct);
        return hits.Take(MaxCandidates)
            .Select(h => new LookupCandidate(h.Id, h.Title, h.OriginalTitle, h.Year, h.PosterPath, TmdbClient.PosterUrl(h.PosterPath)))
            .ToList();
    }

    public async Task<TmdbDraftResponse?> DraftAsync(int tmdbId, CancellationToken ct)
    {
        var movie = await tmdb.GetMovieAsync(tmdbId, ct);
        if (movie is null) return null;
        var fields = await FieldCatalog.LoadAsync(db, ct);
        var draft = TmdbMapper.ToDraft(TmdbMapper.FullDraft(movie), fields);
        var duplicates = await DuplicateFinder.FindAsync(db, draft, movie.Id, null, ct);
        return new TmdbDraftResponse(movie.Id, movie.PosterPath, TmdbClient.PosterUrl(movie.PosterPath, "w500"), draft, duplicates);
    }
}
