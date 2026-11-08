using System.Globalization;
using System.Security.Claims;
using System.Text.Json;
using CineManager.Api.Auth;
using CineManager.Api.Data;
using CineManager.Api.Infrastructure;
using Npgsql;
using NpgsqlTypes;
using Microsoft.EntityFrameworkCore;

namespace CineManager.Api.Endpoints;

public sealed record StateResponse(Dictionary<string, string> Status, Dictionary<string, int> Rating);

public sealed record MigrateResponse(int Imported);

public static class StateEndpoints
{
    private const string Seen = "seen";
    private const string Watchlist = "watchlist";

    public static void MapStateEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/state").RequireAuthorization(Policies.User);

        group.MapGet("", async (ClaimsPrincipal user, CinemaDbContext db, CancellationToken ct) =>
        {
            var sub = user.Sub();
            var rows = await db.UserMovieStates.AsNoTracking().Where(s => s.UserSub == sub).ToListAsync(ct);
            var status = new Dictionary<string, string>();
            var rating = new Dictionary<string, int>();
            foreach (var r in rows)
            {
                var key = r.MovieId.ToString(CultureInfo.InvariantCulture);
                if (r.Status is not null) status[key] = r.Status;
                if (r.Rating is { } v) rating[key] = v;
            }
            return new StateResponse(status, rating);
        });

        // Corpo { "status": ... } oppure { "rating": ... }: conta la presenza della chiave, null = "nessuno".
        group.MapPut("/{movieId:int}", async (int movieId, JsonElement body, ClaimsPrincipal user,
            CinemaDbContext db, TimeProvider clock, CancellationToken ct) =>
        {
            if (body.ValueKind != JsonValueKind.Object)
                return ApiResults.Bad("Il corpo deve essere un oggetto JSON.");
            var hasStatus = body.TryGetProperty("status", out var statusEl);
            var hasRating = body.TryGetProperty("rating", out var ratingEl);
            if (!hasStatus && !hasRating)
                return ApiResults.Bad("Serve 'status' oppure 'rating'.");

            string? status = null;
            short? rating = null;
            if (hasStatus && !TryReadStatus(statusEl, out status))
                return ApiResults.Bad("'status' deve essere \"seen\", \"watchlist\" o null.");
            if (hasRating && !TryReadRating(ratingEl, out rating))
                return ApiResults.Bad("'rating' deve essere un intero da 1 a 5 o null.");

            if (!await db.Movies.AnyAsync(m => m.Id == movieId, ct))
                return Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "Film inesistente");

            try
            {
                await UpsertAsync(db, user.Sub(), movieId, hasStatus, status, hasRating, rating, clock.GetUtcNow(), ct);
            }
            catch (PostgresException ex) when (ex.SqlState == PostgresErrorCodes.ForeignKeyViolation)
            {
                // Film cancellato tra il controllo e la scrittura.
                return Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "Film inesistente");
            }
            return Results.NoContent();
        });

        // Migrazione delle scelte salvate in localStorage: scrive solo dove l'utente non ha già un valore.
        group.MapPost("/migrate", async (JsonElement body, ClaimsPrincipal user, CinemaDbContext db,
            TimeProvider clock, CancellationToken ct) =>
        {
            if (body.ValueKind != JsonValueKind.Object)
                return ApiResults.Bad("Il corpo deve essere un oggetto JSON.");

            var statuses = new Dictionary<int, string>();
            var ratings = new Dictionary<int, short>();
            if (body.TryGetProperty("status", out var sEl) && sEl.ValueKind == JsonValueKind.Object)
                foreach (var p in sEl.EnumerateObject())
                    if (TryParseId(p.Name, out var id) && TryReadStatus(p.Value, out var s) && s is not null)
                        statuses[id] = s;
            if (body.TryGetProperty("rating", out var rEl) && rEl.ValueKind == JsonValueKind.Object)
                foreach (var p in rEl.EnumerateObject())
                    if (TryParseId(p.Name, out var id) && TryReadRating(p.Value, out var r) && r is not null)
                        ratings[id] = r.Value;

            var ids = statuses.Keys.Concat(ratings.Keys).Distinct().ToArray();
            if (ids.Length == 0) return Results.Ok(new MigrateResponse(0));
            var st = ids.Select(id => statuses.GetValueOrDefault(id)).ToArray();
            var rt = ids.Select(id => ratings.TryGetValue(id, out var r) ? r : (short?)null).ToArray();

            // Un'unica istruzione: nessuna violazione della chiave con richieste simultanee. I valori
            // esistenti vincono (COALESCE); "imported" conta i valori che non c'erano, dalla foto
            // iniziale della stessa istruzione. Gli id di film inesistenti vengono scartati.
            var imported = (await db.Database.SqlQueryRaw<int>("""
                WITH x AS (
                    SELECT x.id, x.status, x.rating
                    FROM unnest(@ids, @st, @rt) AS x(id, status, rating)
                    WHERE EXISTS (SELECT 1 FROM movies m WHERE m.id = x.id)
                ), old AS (
                    SELECT s.movie_id, s.status, s.rating FROM user_movie_state s
                    WHERE s.user_sub = @sub AND s.movie_id IN (SELECT id FROM x)
                ), up AS (
                    INSERT INTO user_movie_state AS u (user_sub, movie_id, status, rating, updated_at)
                    SELECT @sub, x.id, x.status, x.rating, @now FROM x
                    ON CONFLICT (user_sub, movie_id) DO UPDATE SET
                        status = COALESCE(u.status, EXCLUDED.status),
                        rating = COALESCE(u.rating, EXCLUDED.rating),
                        updated_at = CASE
                            WHEN (u.status IS NULL AND EXCLUDED.status IS NOT NULL)
                              OR (u.rating IS NULL AND EXCLUDED.rating IS NOT NULL) THEN EXCLUDED.updated_at
                            ELSE u.updated_at END
                    RETURNING 1
                )
                SELECT COALESCE(SUM((x.status IS NOT NULL AND o.status IS NULL)::int
                                  + (x.rating IS NOT NULL AND o.rating IS NULL)::int), 0)::int AS "Value"
                FROM x LEFT JOIN old o ON o.movie_id = x.id
                """,
                new NpgsqlParameter("ids", NpgsqlDbType.Array | NpgsqlDbType.Integer) { Value = ids },
                new NpgsqlParameter("st", NpgsqlDbType.Array | NpgsqlDbType.Text) { Value = st },
                new NpgsqlParameter("rt", NpgsqlDbType.Array | NpgsqlDbType.Smallint) { Value = rt },
                new NpgsqlParameter("sub", user.Sub()),
                new NpgsqlParameter("now", clock.GetUtcNow())).ToListAsync(ct)).Single(); // niente composizione: il WITH resta in cima
            return Results.Ok(new MigrateResponse(imported));
        });
    }

    /// <summary>
    /// Scrittura atomica di stato e/o voto (conta la presenza della chiave). Se dopo la scrittura
    /// resterebbero entrambi null la riga si cancella. Niente lettura + scrittura separate: due PUT
    /// simultanei sullo stesso film non violano più la chiave primaria.
    /// </summary>
    private static Task UpsertAsync(CinemaDbContext db, string sub, int movieId, bool hasStatus, string? status,
        bool hasRating, short? rating, DateTimeOffset now, CancellationToken ct)
    {
        var p = new object[]
        {
            new NpgsqlParameter("sub", sub), new NpgsqlParameter("id", movieId),
            new NpgsqlParameter("hasS", hasStatus), new NpgsqlParameter("s", NpgsqlDbType.Text) { Value = (object?)status ?? DBNull.Value },
            new NpgsqlParameter("hasR", hasRating), new NpgsqlParameter("r", NpgsqlDbType.Smallint) { Value = (object?)rating ?? DBNull.Value },
            new NpgsqlParameter("now", now),
        };
        if (status is not null || rating is not null)
            // Almeno un valore non null: la riga, nuova o aggiornata, non resta mai vuota.
            return db.Database.ExecuteSqlRawAsync("""
                INSERT INTO user_movie_state AS u (user_sub, movie_id, status, rating, updated_at)
                VALUES (@sub, @id, @s, @r, @now)
                ON CONFLICT (user_sub, movie_id) DO UPDATE SET
                    status = CASE WHEN @hasS THEN EXCLUDED.status ELSE u.status END,
                    rating = CASE WHEN @hasR THEN EXCLUDED.rating ELSE u.rating END,
                    updated_at = EXCLUDED.updated_at
                """, p, ct);
        // Solo azzeramenti: si cancella la riga se non resta nulla, altrimenti si azzera il campo.
        // Le due condizioni si escludono e Postgres le rivaluta sulla versione più recente della riga.
        return db.Database.ExecuteSqlRawAsync("""
            DELETE FROM user_movie_state
            WHERE user_sub = @sub AND movie_id = @id AND (@hasS OR status IS NULL) AND (@hasR OR rating IS NULL);
            UPDATE user_movie_state SET
                status = CASE WHEN @hasS THEN NULL ELSE status END,
                rating = CASE WHEN @hasR THEN NULL ELSE rating END,
                updated_at = @now
            WHERE user_sub = @sub AND movie_id = @id AND NOT ((@hasS OR status IS NULL) AND (@hasR OR rating IS NULL));
            """, p, ct);
    }

    private static bool TryParseId(string s, out int id) =>
        int.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out id) && id > 0;

    /// <summary>null oppure uno stato valido.</summary>
    private static bool TryReadStatus(JsonElement el, out string? status)
    {
        status = el.ValueKind == JsonValueKind.String ? el.GetString() : null;
        return el.ValueKind == JsonValueKind.Null || status is Seen or Watchlist;
    }

    /// <summary>null oppure un intero da 1 a 5.</summary>
    private static bool TryReadRating(JsonElement el, out short? rating)
    {
        rating = el.ValueKind == JsonValueKind.Number && el.TryGetInt16(out var v) && v is >= 1 and <= 5 ? v : null;
        return el.ValueKind == JsonValueKind.Null || rating is not null;
    }
}
