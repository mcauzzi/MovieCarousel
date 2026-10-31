using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using CineManager.Api.Data;
using CineManager.Api.Import;
using CineManager.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

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
    private static readonly HashSet<string> PatchKeys = ["movie"];

    /// <summary>Tempo massimo per scaricare la copertina, indipendente dalla richiesta dell'app.</summary>
    public static readonly TimeSpan CoverTimeout = TimeSpan.FromSeconds(30);

    /// <summary>Tentativi di inserimento se l'id della sequenza è già occupato (id Tellico ≥ 1 000 000).</summary>
    private const int MaxIdAttempts = 5;

    private string BarcodeField => tellico.Value.BarcodeField;

    public async Task<ArrivalOutcome> CreateAsync(JsonElement body, string ownerSub, Guid deviceId, CancellationToken ct)
    {
        if (ReadBody(body, CreateKeys, out var movieEl) is { } badBody) return badBody;

        string? ean = null;
        if (body.TryGetProperty("ean", out var eanEl) && eanEl.ValueKind != JsonValueKind.Null)
        {
            ean = EanNormalizer.Normalize(eanEl.ValueKind switch
            {
                JsonValueKind.String => eanEl.GetString(),
                JsonValueKind.Number => eanEl.GetRawText(),
                _ => null,
            });
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

        var result = await ValidateAsync(movieEl, allowBarcode: false, ct);
        if (!result.Ok) return FieldErrors(result.Errors);

        var data = new JsonObject();
        foreach (var (k, v) in result.Values)
            if (v is not null) data[k] = v;
        if (TitleOf(data) is null) return MissingTitle();

        Movie movie;
        await using (var tx = await db.Database.BeginTransactionAsync(ct))
        {
            // Condiviso: niente arrivi a metà di un import o di un export (che lo prendono esclusivo).
            await CollectionLock.SharedAsync(db, ct);
            if (ean is not null && await EanConflictAsync(ean, null, ct) is { } conflict) return conflict;
            if (!confirm)
            {
                var dups = await DuplicateFinder.FindAsync(db, data, tmdbId, null, ct);
                if (dups.Count > 0) return new ArrivalOutcome.PossibleDuplicate(dups);
            }

            // cdate = data di inserimento: il film compare tra le novità come quelli di Tellico.
            data["cdate"] = clock.GetLocalNow().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            Movie.SetBarcode(data, BarcodeField, ean);

            // created_at letto dopo il lock: il cutoff dell'export (preso con il lock esclusivo) lo separa con certezza.
            var now = clock.GetUtcNow();
            movie = new Movie
            {
                Id = await db.NextMovieIdAsync(ct), Ean = ean, Source = MovieSources.App, TmdbId = tmdbId,
                CreatedAt = now, UpdatedAt = now, CreatedBy = ownerSub, CreatedByDevice = deviceId,
                Data = data.ToJsonString(),
            };
            db.Movies.Add(movie);
            for (var attempt = 1; ; attempt++)
            {
                try
                {
                    await db.SaveChangesAsync(ct); // in una transazione EF usa un savepoint: si può riprovare
                    break;
                }
                catch (DbUpdateException ex) when (ex.IsUniqueViolation("pk_movies") && attempt < MaxIdAttempts)
                {
                    // Id già preso (es. un id Tellico importato prima dell'allineamento della sequenza).
                    log.LogWarning("Id {Id} già occupato: nuovo valore dalla sequenza", movie.Id);
                    db.Entry(movie).State = EntityState.Detached;
                    movie.Id = await db.NextMovieIdAsync(ct);
                    db.Movies.Add(movie);
                }
                catch (DbUpdateException ex) when (ean is not null && ex.IsUniqueViolation())
                {
                    // Stesso EAN inserito nel frattempo da un'altra richiesta.
                    db.ChangeTracker.Clear();
                    if (await EanConflictAsync(ean, null, ct) is { } raced) return raced;
                    throw;
                }
            }
            await tx.CommitAsync(ct);
        }
        log.LogInformation("Arrivo {Id} dall'app (dispositivo {Device}, utente {Sub})", movie.Id, deviceId, ownerSub);

        // Il film è salvato: da qui in poi niente può più far fallire la richiesta (ritentando l'app
        // riceverebbe 409). La copertina ha un timeout suo e non segue l'annullamento della richiesta.
        if (posterPath is not null) await AttachCoverAsync(movie.Id, posterPath);
        return new ArrivalOutcome.Created(movie.Id);
    }

    /// <summary>Scarica la copertina e la scrive in <c>data.cover</c>; ogni errore lascia il film senza copertina.</summary>
    private async Task AttachCoverAsync(int movieId, string posterPath)
    {
        try
        {
            using var cts = new CancellationTokenSource(CoverTimeout);
            var cover = await downloader.DownloadAsync(movieId, posterPath, cts.Token);
            if (cover is null) return;
            await using var tx = await db.Database.BeginTransactionAsync(CancellationToken.None);
            await CollectionLock.SharedAsync(db, CancellationToken.None);
            // Solo la chiave cover, in un'unica istruzione: non sovrascrive modifiche arrivate nel frattempo.
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"UPDATE movies SET data = jsonb_set(data, '{{cover}}', to_jsonb({cover}::text)) WHERE id = {movieId}",
                CancellationToken.None);
            await tx.CommitAsync(CancellationToken.None);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Copertina del film {Id} non salvata: il film resta senza copertina", movieId);
        }
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
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await CollectionLock.SharedAsync(db, ct);
        var movie = await db.Movies.FirstOrDefaultAsync(m => m.Id == id, ct);
        if (CheckAccess(movie, sub, isAdmin) is { } denied) return denied;

        if (ReadBody(body, PatchKeys, out var movieEl) is { } badBody) return badBody;
        var result = await ValidateAsync(movieEl, allowBarcode: true, ct);
        if (!result.Ok) return FieldErrors(result.Errors);

        var data = Movie.ParseData(movie!.Data);
        foreach (var (k, v) in result.Values)
        {
            if (v is null) data.Remove(k);
            else data[k] = v;
        }
        if (TitleOf(data) is null) return MissingTitle();

        if (result.HasEan && result.Ean != movie.Ean)
        {
            if (result.Ean is not null && await EanConflictAsync(result.Ean, movie.Id, ct) is { } conflict) return conflict;
            movie.Ean = result.Ean;
        }
        if (result.HasEan) Movie.SetBarcode(data, BarcodeField, movie.Ean);

        movie.Data = data.ToJsonString();
        movie.UpdatedAt = clock.GetUtcNow();
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.IsUniqueViolation())
        {
            db.ChangeTracker.Clear();
            if (result.Ean is not null && await EanConflictAsync(result.Ean, id, ct) is { } raced) return raced;
            throw;
        }
        await tx.CommitAsync(ct);
        var names = await UserNamesAsync([movie.CreatedBy], ct);
        return new ArrivalOutcome.Updated(ToDto(movie, names));
    }

    public async Task<ArrivalOutcome> DeleteAsync(int id, string sub, bool isAdmin, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await CollectionLock.SharedAsync(db, ct);
        var movie = await db.Movies.FirstOrDefaultAsync(m => m.Id == id, ct);
        if (CheckAccess(movie, sub, isAdmin) is { } denied) return denied;
        // Lo stato visto/voto collegato sparisce con il film (FK con ON DELETE CASCADE).
        db.Movies.Remove(movie!);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        covers.DeleteAppCovers(id);
        log.LogInformation("Arrivo {Id} eliminato da {Sub}", id, sub);
        return new ArrivalOutcome.Deleted();
    }

    /// <summary>Oggetto JSON, senza NUL né chiavi duplicate, solo con <paramref name="keys"/> e con <c>movie</c> oggetto.</summary>
    private static ArrivalOutcome.Invalid? ReadBody(JsonElement body, HashSet<string> keys, out JsonElement movie)
    {
        movie = default;
        if (body.ValueKind != JsonValueKind.Object) return new("Il corpo deve essere un oggetto JSON.");
        if (JsonSafety.Problem(body) is { } unsafeJson) return new(unsafeJson);
        foreach (var p in body.EnumerateObject())
            if (!keys.Contains(p.Name)) return new($"Proprietà sconosciuta: '{p.Name}'.");
        if (!body.TryGetProperty("movie", out movie) || movie.ValueKind != JsonValueKind.Object)
            return new("'movie' mancante o non è un oggetto.");
        return null;
    }

    private async Task<MovieValidator.Result> ValidateAsync(JsonElement movie, bool allowBarcode, CancellationToken ct) =>
        new MovieValidator(await FieldCatalog.LoadAsync(db, ct), BarcodeField, clock.GetLocalNow().Year)
            .Validate((JsonObject)JsonNode.Parse(movie.GetRawText())!, allowBarcode);

    private static ArrivalOutcome.Invalid FieldErrors(Dictionary<string, string[]> errors) => new("Campi non validi.", errors);

    private static ArrivalOutcome.Invalid MissingTitle() => FieldErrors(new() { ["title"] = ["Il titolo è obbligatorio."] });

    /// <summary>
    /// Esiste, è un arrivo dall'app, è dell'utente (o l'utente è admin). La sorgente si controlla
    /// prima del proprietario: un film di Tellico dà 409 a chiunque, come da contratto.
    /// </summary>
    private static ArrivalOutcome? CheckAccess(Movie? movie, string sub, bool isAdmin)
    {
        if (movie is null) return new ArrivalOutcome.NotFound();
        if (movie.Source != MovieSources.App) return new ArrivalOutcome.NotAnArrival();
        if (!isAdmin && movie.CreatedBy != sub) return new ArrivalOutcome.Forbidden();
        return null;
    }

    /// <summary>409 se un altro film (diverso da <paramref name="excludeId"/>) ha già l'EAN.</summary>
    private async Task<ArrivalOutcome.EanConflict?> EanConflictAsync(string ean, int? excludeId, CancellationToken ct)
    {
        var row = await db.Movies.AsNoTracking().Where(m => m.Ean == ean && m.Id != excludeId)
            .Select(m => new { m.Id, m.Data }).FirstOrDefaultAsync(ct);
        return row is null ? null : new(row.Id, TitleOf(Movie.ParseData(row.Data)));
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

    private static ArrivalDto ToDto(Movie m, Dictionary<string, string> names) => new(
        m.Id, m.Ean, m.TmdbId, m.Source, m.CreatedAt, m.CreatedBy,
        m.CreatedBy is { } s && names.TryGetValue(s, out var n) ? n : null, m.ExportedAt, Movie.ToJson(m.Id, m.Data));
}
