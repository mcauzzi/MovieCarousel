using System.Globalization;
using System.Security.Claims;
using System.Text.Json;
using CineManager.Api.Auth;
using CineManager.Api.Data;
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
            var sub = Sub(user);
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
                return Bad("Il corpo deve essere un oggetto JSON.");
            var hasStatus = body.TryGetProperty("status", out var statusEl);
            var hasRating = body.TryGetProperty("rating", out var ratingEl);
            if (!hasStatus && !hasRating)
                return Bad("Serve 'status' oppure 'rating'.");

            string? status = null;
            short? rating = null;
            if (hasStatus && !TryReadStatus(statusEl, out status))
                return Bad("'status' deve essere \"seen\", \"watchlist\" o null.");
            if (hasRating && !TryReadRating(ratingEl, out rating))
                return Bad("'rating' deve essere un intero da 1 a 5 o null.");

            if (!await db.Movies.AnyAsync(m => m.Id == movieId, ct))
                return Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "Film inesistente");

            var sub = Sub(user);
            var row = await db.UserMovieStates.FindAsync([sub, movieId], ct);
            if (row is null)
            {
                row = new UserMovieState { UserSub = sub, MovieId = movieId };
                db.UserMovieStates.Add(row);
            }
            if (hasStatus) row.Status = status;
            if (hasRating) row.Rating = rating;
            row.UpdatedAt = clock.GetUtcNow();

            if (row.Status is null && row.Rating is null)
            {
                if (db.Entry(row).State == EntityState.Added) db.Entry(row).State = EntityState.Detached;
                else db.UserMovieStates.Remove(row); // stato e voto entrambi null: la riga sparisce
            }
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        // Migrazione delle scelte salvate in localStorage: scrive solo dove l'utente non ha già un valore.
        group.MapPost("/migrate", async (JsonElement body, ClaimsPrincipal user, CinemaDbContext db,
            TimeProvider clock, CancellationToken ct) =>
        {
            if (body.ValueKind != JsonValueKind.Object)
                return Bad("Il corpo deve essere un oggetto JSON.");

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

            var ids = statuses.Keys.Concat(ratings.Keys).Distinct().ToList();
            if (ids.Count == 0) return Results.Ok(new MigrateResponse(0));

            var sub = Sub(user);
            var existingMovies = (await db.Movies.Where(m => ids.Contains(m.Id)).Select(m => m.Id).ToListAsync(ct)).ToHashSet();
            var rows = await db.UserMovieStates.Where(s => s.UserSub == sub && ids.Contains(s.MovieId))
                .ToDictionaryAsync(s => s.MovieId, ct);
            var now = clock.GetUtcNow();
            var imported = 0;
            foreach (var id in ids.Where(existingMovies.Contains))
            {
                if (!rows.TryGetValue(id, out var row))
                {
                    row = new UserMovieState { UserSub = sub, MovieId = id };
                    rows[id] = row;
                    db.UserMovieStates.Add(row);
                }
                var touched = false;
                if (statuses.TryGetValue(id, out var s) && row.Status is null) { row.Status = s; imported++; touched = true; }
                if (ratings.TryGetValue(id, out var r) && row.Rating is null) { row.Rating = r; imported++; touched = true; }
                if (touched) row.UpdatedAt = now;
            }
            await db.SaveChangesAsync(ct);
            return Results.Ok(new MigrateResponse(imported));
        });
    }

    private static string Sub(ClaimsPrincipal user) => user.FindFirst(CmClaims.Sub)!.Value;

    private static IResult Bad(string detail) =>
        Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: "Richiesta non valida", detail: detail);

    private static bool TryParseId(string s, out int id) =>
        int.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out id) && id > 0;

    private static bool TryReadStatus(JsonElement el, out string? status)
    {
        status = null;
        if (el.ValueKind == JsonValueKind.Null) return true;
        if (el.ValueKind != JsonValueKind.String) return false;
        status = el.GetString();
        return status is Seen or Watchlist;
    }

    private static bool TryReadRating(JsonElement el, out short? rating)
    {
        rating = null;
        if (el.ValueKind == JsonValueKind.Null) return true;
        if (el.ValueKind != JsonValueKind.Number || !el.TryGetInt16(out var v) || v is < 1 or > 5) return false;
        rating = v;
        return true;
    }
}
