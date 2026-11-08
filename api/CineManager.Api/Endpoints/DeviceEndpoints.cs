using System.Security.Claims;
using CineManager.Api.Auth;
using CineManager.Api.Data;
using CineManager.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace CineManager.Api.Endpoints;

public sealed record DeviceDto(
    Guid Id, string Name, string UserSub, string? UserName, DateTimeOffset CreatedAt, DateTimeOffset? LastSeenAt,
    DateTimeOffset? RevokedAt);

/// <summary>Dispositivi abbinati e logout forzato (§6.2).</summary>
public static class DeviceEndpoints
{
    public static void MapDeviceEndpoints(this IEndpointRouteBuilder app)
    {
        // Propri dispositivi; ?all=true (solo admin) quelli di tutti.
        app.MapGet("/api/devices", async (bool? all, ClaimsPrincipal user, CinemaDbContext db, CancellationToken ct) =>
        {
            var everyone = all == true;
            if (everyone && !user.IsInRole(Roles.Admin)) return Results.Forbid();
            var sub = user.Sub();
            var q = db.Devices.AsNoTracking();
            if (!everyone) q = q.Where(d => d.UserSub == sub);
            // Join esplicito ordinato prima della proiezione (traducibile da EF Core).
            var list = await (
                from d in q
                join u in db.Users.AsNoTracking() on d.UserSub equals u.Sub into us
                from u in us.DefaultIfEmpty()
                orderby d.CreatedAt descending
                select new DeviceDto(d.Id, d.Name, d.UserSub, u == null ? null : (u.DisplayName ?? u.Username),
                    d.CreatedAt, d.LastSeenAt, d.RevokedAt)).ToListAsync(ct);
            return Results.Ok(list);
        }).RequireAuthorization(Policies.User);

        // Revoca: proprio dispositivo, o qualsiasi per l'admin. Idempotente.
        app.MapDelete("/api/devices/{id:guid}", async (Guid id, ClaimsPrincipal user, CinemaDbContext db, TimeProvider clock,
            CancellationToken ct) =>
        {
            var device = await db.Devices.FirstOrDefaultAsync(d => d.Id == id, ct);
            if (device is null) return Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "Dispositivo inesistente");
            if (device.UserSub != user.Sub() && !user.IsInRole(Roles.Admin)) return Results.Forbid();
            device.RevokedAt ??= clock.GetUtcNow();
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        }).RequireAuthorization(Policies.User);

        var users = app.MapGroup("/api/users/{sub}").RequireAuthorization(Policies.Admin);

        // Revoca tutti i dispositivi di un utente.
        users.MapDelete("/devices", async (string sub, CinemaDbContext db, TimeProvider clock, CancellationToken ct) =>
        {
            var now = clock.GetUtcNow();
            await db.Devices.Where(d => d.UserSub == sub && d.RevokedAt == null)
                .ExecuteUpdateAsync(s => s.SetProperty(d => d.RevokedAt, now), ct);
            return Results.NoContent();
        });

        // Logout forzato dal sito: nuovo timbro di sicurezza (§4.1).
        users.MapDelete("/sessions", async (string sub, UserSync sync, CancellationToken ct) =>
            await sync.RegenerateStampAsync(sub, ct)
                ? Results.NoContent()
                : Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "Utente inesistente"));
    }
}
