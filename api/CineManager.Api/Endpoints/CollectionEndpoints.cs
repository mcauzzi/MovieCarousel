using System.Security.Claims;
using System.Text.Json.Nodes;
using CineManager.Api.Auth;
using CineManager.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace CineManager.Api.Endpoints;

public sealed record MeResponse(string Sub, string Name, IReadOnlyList<string> Roles);

public sealed record CollectionFieldDto(
    string Name, string Title, string Type, bool Multiple, IReadOnlyList<string>? Allowed, string Origin,
    bool Groupable, int GroupMinSize, bool InForm, int Ordinal);

public sealed record CollectionResponse(IReadOnlyList<JsonObject> Movies, IReadOnlyList<CollectionFieldDto> Fields);

public static class CollectionEndpoints
{
    public static void MapCollectionEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/health", async (CinemaDbContext db, CancellationToken ct) =>
        {
            bool ok;
            try
            {
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                cts.CancelAfter(TimeSpan.FromSeconds(3));
                ok = await db.Database.CanConnectAsync(cts.Token);
            }
            catch (Exception) { ok = false; }
            return ok
                ? Results.Ok(new { status = "ok", db = "ok" })
                : Results.Json(new { status = "error", db = "error" }, statusCode: StatusCodes.Status503ServiceUnavailable);
        }).AllowAnonymous().DisableRateLimiting();

        app.MapGet("/api/me", (ClaimsPrincipal user) =>
        {
            var sub = user.FindFirst(CmClaims.Sub)!.Value;
            var name = user.FindFirst(CmClaims.Name)?.Value ?? user.FindFirst(CmClaims.Username)?.Value ?? sub;
            // Solo ruoli noti, nell'ordine del contratto: ["user"] | ["user","admin"] (o [] senza ruolo).
            var roles = new[] { Roles.User, Roles.Admin }.Where(user.IsInRole).ToArray();
            return new MeResponse(sub, name, roles);
        }).RequireAuthorization();

        app.MapGet("/api/collection", async (CinemaDbContext db, CancellationToken ct) =>
        {
            var rows = await db.Movies.AsNoTracking().OrderBy(m => m.Id)
                .Select(m => new { m.Id, m.Data }).ToListAsync(ct);
            var movies = rows.Select(r =>
            {
                var obj = JsonNode.Parse(r.Data) as JsonObject ?? new JsonObject();
                obj["id"] = r.Id;
                return obj;
            }).ToList();
            var fields = await db.CollectionFields.AsNoTracking()
                .OrderBy(f => f.Ordinal).ThenBy(f => f.Name)
                .Select(f => new CollectionFieldDto(f.Name, f.Title, f.Type, f.Multiple, f.Allowed, f.Origin,
                    f.Groupable, f.GroupMinSize, f.InForm, f.Ordinal))
                .ToListAsync(ct);
            return new CollectionResponse(movies, fields);
        }).RequireAuthorization(Policies.User);
    }
}
