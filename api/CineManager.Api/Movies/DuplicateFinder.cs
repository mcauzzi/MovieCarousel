using System.Text.Json.Nodes;
using CineManager.Api.Data;
using CineManager.Api.Import;
using Microsoft.EntityFrameworkCore;

namespace CineManager.Api.Movies;

public sealed record DuplicateCandidate(int Id, string? Title, int? Year);

/// <summary>
/// Possibili duplicati (§7, passo 5): film con titolo + anno normalizzati uguali (stessa
/// normalizzazione dell'import, §8) o con lo stesso <c>tmdb_id</c>; in più, se indicato, lo
/// stesso EAN.
/// </summary>
public static class DuplicateFinder
{
    private sealed class Row
    {
        public int Id { get; set; }
        public int? TmdbId { get; set; }
        public string? Ean { get; set; }
        public string? Title { get; set; }
        public string? Year { get; set; }
    }

    public static async Task<List<DuplicateCandidate>> FindAsync(CinemaDbContext db, JsonObject draft, int? tmdbId,
        string? ean, CancellationToken ct, int? excludeId = null)
    {
        var key = TitleNormalizer.Key(draft);
        if (key is null && tmdbId is null && ean is null) return [];

        var rows = await db.Database.SqlQuery<Row>($"""
            SELECT id AS "Id", tmdb_id AS "TmdbId", ean AS "Ean",
                   data->>'title' AS "Title", data->>'year' AS "Year"
            FROM movies
            """).ToListAsync(ct);

        var result = new List<DuplicateCandidate>();
        foreach (var r in rows)
        {
            if (r.Id == excludeId) continue;
            var same = (tmdbId is not null && r.TmdbId == tmdbId) || (ean is not null && r.Ean == ean);
            if (!same && key is not null)
                same = TitleNormalizer.Key(new JsonObject { ["title"] = r.Title, ["year"] = r.Year }) == key;
            if (same)
                result.Add(new DuplicateCandidate(r.Id, r.Title,
                    int.TryParse(r.Year, out var y) ? y : (double.TryParse(r.Year, System.Globalization.CultureInfo.InvariantCulture, out var d) ? (int)d : null)));
        }
        return result.OrderBy(c => c.Id).Take(20).ToList();
    }
}
