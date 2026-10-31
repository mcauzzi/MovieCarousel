using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using CineManager.Api.Data;
using CineManager.Api.Import;
using CineManager.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Npgsql;

namespace CineManager.Api.Movies;

/// <summary>Elemento di <c>GET /api/arrivals</c> e risposta di <c>PATCH /api/movies/{id}</c>.</summary>
public sealed record ArrivalDto(
    int Id, string? Ean, int? TmdbId, string Source, DateTimeOffset CreatedAt, string? CreatedBy, string? CreatedByName,
    DateTimeOffset? ExportedAt, JsonObject Movie);

/// <summary>Esito di un'operazione sugli arrivi, tradotto in HTTP dagli endpoint.</summary>
public abstract record ArrivalOutcome
{
    public sealed record Created(int Id) : ArrivalOutcome;
    public sealed record Updated(ArrivalDto Arrival) : ArrivalOutcome;
    public sealed record Deleted : ArrivalOutcome;
    public sealed record Invalid(string Detail, Dictionary<string, string[]>? Errors = null) : ArrivalOutcome;
    public sealed record EanConflict(int ExistingId, string? Title) : ArrivalOutcome;
    public sealed record PossibleDuplicate(IReadOnlyList<DuplicateCandidate> Candidates) : ArrivalOutcome;
    public sealed record NotFound : ArrivalOutcome;
    public sealed record Forbidden : ArrivalOutcome;
    public sealed record NotAnArrival : ArrivalOutcome;
}

/// <summary>
/// Arrivi dall'app: inserimento (<c>POST /api/app/movies</c>, §6.3), correzione ed eliminazione
/// dal sito (<c>PATCH</c>/<c>DELETE /api/movies/{id}</c>, §6.2), elenco (§6.2, <c>/api/arrivals</c>).
/// </summary>
public sealed class ArrivalService(
    CinemaDbContext db, CoverDownloader downloader, CoverStore covers, IOptions<TellicoOptions> tellico,
    TimeProvider clock, ILogger<ArrivalService> log)
{
    private static readonly HashSet<string> CreateKeys = ["ean", "tmdbId", "posterPath", "movie", "confirmDuplicate"];

    private string BarcodeField => tellico.Value.BarcodeField;

    public async Task<ArrivalOutcome> CreateAsync(JsonElement body, string ownerSub, Guid deviceId, CancellationToken ct)
    {
        if (body.ValueKind != JsonValueKind.Object) return new ArrivalOutcome.Invalid("Il corpo deve essere un oggetto JSON.");
        foreach (var p in body.EnumerateObject())
            if (!CreateKeys.Contains(p.Name)) return new ArrivalOutcome.Invalid($"Proprietà sconosciuta: '{p.Name}'.");

        if (!body.TryGetProperty("movie", out var movieEl) || movieEl.ValueKind != JsonValueKind.Object)
            return new ArrivalOutcome.Invalid("'movie' mancante o non è un oggetto.");

        string? ean = null;
        if (body.TryGetProperty("ean", out var eanEl) && eanEl.ValueKind != JsonValueKind.Null)
        {
            var raw = eanEl.ValueKind switch
            {
                JsonValueKind.String => eanEl.GetString(),
                JsonValueKind.Number => eanEl.GetRawText(),
                _ => null,
            };
            ean = EanNormalizer.Normalize(raw);
            if (ean is null || !MovieValidator.IsValidEan(ean)) return new ArrivalOutcome.Invalid("'ean' non valido (8–14 cifre).");
        }

        int? tmdbId = null;
        if (body.TryGetProperty("tmdbId", out var tmdbEl) && tmdbEl.ValueKind != JsonValueKind.Null)
        {
            if (tmdbEl.ValueKind != JsonValueKind.Number || !tmdbEl.TryGetInt32(out var t) || t <= 0)
                return new ArrivalOutcome.Invalid("'tmdbId' deve essere un intero positivo.");
            tmdbId = t;
        }

        string? posterPath = null;
        if (body.TryGetProperty("posterPath", out var posterEl) && posterEl.ValueKind != JsonValueKind.Null)
        {
            posterPath = posterEl.ValueKind == JsonValueKind.String ? posterEl.GetString() : null;
            if (!CoverDownloader.IsValidPosterPath(posterPath))
                return new ArrivalOutcome.Invalid("'posterPath' non valido (atteso il percorso TMDb, es. /abc123.jpg).");
        }

        var confirm = false;
        if (body.TryGetProperty("confirmDuplicate", out var confirmEl) && confirmEl.ValueKind != JsonValueKind.Null)
        {
            if (confirmEl.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                return new ArrivalOutcome.Invalid("'confirmDuplicate' deve essere un booleano.");
            confirm = confirmEl.GetBoolean();
        }

        var fields = await FieldCatalog.LoadAsync(db, ct);
        var validator = new MovieValidator(fields, BarcodeField, clock.GetLocalNow().Year);
        var result = validator.Validate((JsonObject)JsonNode.Parse(movieEl.GetRawText())!, allowBarcode: false);
        if (!result.Ok) return new ArrivalOutcome.Invalid("Campi non validi.", result.Errors);

        var data = new JsonObject();
        foreach (var (k, v) in result.Values)
            if (v is not null) data[k] = v;
        if (TitleOf(data) is null)
            return new ArrivalOutcome.Invalid("Campi non validi.", new() { ["title"] = ["Il titolo è obbligatorio."] });

        if (ean is not null && await EanHolderAsync(ean, null, ct) is { } holder)
            return new ArrivalOutcome.EanConflict(holder.Id, holder.Title);
        if (!confirm)
        {
            var dups = await DuplicateFinder.FindAsync(db, data, tmdbId, null, ct);
            if (dups.Count > 0) return new ArrivalOutcome.PossibleDuplicate(dups);
        }

        // cdate = data di inserimento: il film compare tra le novità come quelli di Tellico.
        data["cdate"] = clock.GetLocalNow().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        if (ean is not null) data[BarcodeField] = ean;

        var now = clock.GetUtcNow();
        var movie = new Movie
        {
            Id = await db.NextMovieIdAsync(ct), Ean = ean, Source = MovieSources.App, TmdbId = tmdbId,
            CreatedAt = now, UpdatedAt = now, CreatedBy = ownerSub, CreatedByDevice = deviceId,
            Data = data.ToJsonString(),
        };
        db.Movies.Add(movie);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (ean is not null && ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            // Stesso EAN inserito nel frattempo da un'altra richiesta.
            db.ChangeTracker.Clear();
            if (await EanHolderAsync(ean, null, ct) is { } h) return new ArrivalOutcome.EanConflict(h.Id, h.Title);
            throw;
        }

        if (posterPath is not null)
        {
            var cover = await downloader.DownloadAsync(movie.Id, posterPath, ct);
            if (cover is not null)
            {
                data["cover"] = cover;
                movie.Data = data.ToJsonString();
                await db.SaveChangesAsync(ct);
            }
        }
        log.LogInformation("Arrivo {Id} dall'app (dispositivo {Device}, utente {Sub})", movie.Id, deviceId, ownerSub);
        return new ArrivalOutcome.Created(movie.Id);
    }

    public async Task<List<ArrivalDto>> ListAsync(string scope, string sub, bool isAdmin, CancellationToken ct)
    {
        var q = db.Movies.AsNoTracking().Where(m => m.Source == MovieSources.App);
        if (scope == "new") q = q.Where(m => m.ExportedAt == null);
        if (!isAdmin) q = q.Where(m => m.CreatedBy == sub);
        var rows = await q.OrderByDescending(m => m.CreatedAt).ThenByDescending(m => m.Id).ToListAsync(ct);
        var names = await UserNamesAsync(rows.Select(r => r.CreatedBy), ct);
        return rows.Select(m => ToDto(m, names)).ToList();
    }

    public async Task<ArrivalOutcome> PatchAsync(int id, JsonElement body, string sub, bool isAdmin, CancellationToken ct)
    {
        var movie = await db.Movies.FirstOrDefaultAsync(m => m.Id == id, ct);
        if (CheckAccess(movie, sub, isAdmin) is { } denied) return denied;

        if (body.ValueKind != JsonValueKind.Object) return new ArrivalOutcome.Invalid("Il corpo deve essere un oggetto JSON.");
        foreach (var p in body.EnumerateObject())
            if (p.Name != "movie") return new ArrivalOutcome.Invalid($"Proprietà sconosciuta: '{p.Name}'.");
        if (!body.TryGetProperty("movie", out var movieEl) || movieEl.ValueKind != JsonValueKind.Object)
            return new ArrivalOutcome.Invalid("'movie' mancante o non è un oggetto.");

        var fields = await FieldCatalog.LoadAsync(db, ct);
        var validator = new MovieValidator(fields, BarcodeField, clock.GetLocalNow().Year);
        var result = validator.Validate((JsonObject)JsonNode.Parse(movieEl.GetRawText())!, allowBarcode: true);
        if (!result.Ok) return new ArrivalOutcome.Invalid("Campi non validi.", result.Errors);

        var data = JsonNode.Parse(movie!.Data) as JsonObject ?? new JsonObject();
        foreach (var (k, v) in result.Values)
        {
            if (v is null) data.Remove(k);
            else data[k] = v;
        }
        if (TitleOf(data) is null)
            return new ArrivalOutcome.Invalid("Campi non validi.", new() { ["title"] = ["Il titolo è obbligatorio."] });

        if (result.HasEan && result.Ean != movie.Ean)
        {
            if (result.Ean is not null && await EanHolderAsync(result.Ean, movie.Id, ct) is { } holder)
                return new ArrivalOutcome.EanConflict(holder.Id, holder.Title);
            movie.Ean = result.Ean;
        }
        if (result.HasEan)
        {
            if (movie.Ean is null) data.Remove(BarcodeField);
            else data[BarcodeField] = movie.Ean;
        }

        movie.Data = data.ToJsonString();
        movie.UpdatedAt = clock.GetUtcNow();
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            db.ChangeTracker.Clear();
            if (result.Ean is not null && await EanHolderAsync(result.Ean, id, ct) is { } h)
                return new ArrivalOutcome.EanConflict(h.Id, h.Title);
            throw;
        }
        var names = await UserNamesAsync([movie.CreatedBy], ct);
        return new ArrivalOutcome.Updated(ToDto(movie, names));
    }

    public async Task<ArrivalOutcome> DeleteAsync(int id, string sub, bool isAdmin, CancellationToken ct)
    {
        var movie = await db.Movies.FirstOrDefaultAsync(m => m.Id == id, ct);
        if (CheckAccess(movie, sub, isAdmin) is { } denied) return denied;
        // Lo stato visto/voto collegato sparisce con il film (FK con ON DELETE CASCADE).
        db.Movies.Remove(movie!);
        await db.SaveChangesAsync(ct);
        covers.DeleteAppCovers(id);
        log.LogInformation("Arrivo {Id} eliminato da {Sub}", id, sub);
        return new ArrivalOutcome.Deleted();
    }

    /// <summary>Esiste, è dell'utente (o l'utente è admin), è un arrivo dall'app.</summary>
    private static ArrivalOutcome? CheckAccess(Movie? movie, string sub, bool isAdmin)
    {
        if (movie is null) return new ArrivalOutcome.NotFound();
        if (!isAdmin && movie.CreatedBy != sub) return new ArrivalOutcome.Forbidden();
        if (movie.Source != MovieSources.App) return new ArrivalOutcome.NotAnArrival();
        return null;
    }

    private async Task<(int Id, string? Title)?> EanHolderAsync(string ean, int? excludeId, CancellationToken ct)
    {
        var row = await db.Movies.AsNoTracking().Where(m => m.Ean == ean && m.Id != excludeId)
            .Select(m => new { m.Id, m.Data }).FirstOrDefaultAsync(ct);
        if (row is null) return null;
        return (row.Id, TitleOf(JsonNode.Parse(row.Data) as JsonObject ?? new JsonObject()));
    }

    private static string? TitleOf(JsonObject data) =>
        data["title"] is JsonValue v && v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s) ? s : null;

    private async Task<Dictionary<string, string>> UserNamesAsync(IEnumerable<string?> subs, CancellationToken ct)
    {
        var list = subs.OfType<string>().Distinct().ToList();
        if (list.Count == 0) return [];
        return await db.Users.AsNoTracking().Where(u => list.Contains(u.Sub))
            .ToDictionaryAsync(u => u.Sub, u => u.DisplayName ?? u.Username, ct);
    }

    public static JsonObject MovieJson(Movie m)
    {
        var obj = JsonNode.Parse(m.Data) as JsonObject ?? new JsonObject();
        obj["id"] = m.Id;
        return obj;
    }

    private static ArrivalDto ToDto(Movie m, Dictionary<string, string> names) => new(
        m.Id, m.Ean, m.TmdbId, m.Source, m.CreatedAt, m.CreatedBy,
        m.CreatedBy is { } s && names.TryGetValue(s, out var n) ? n : null, m.ExportedAt, MovieJson(m));
}
