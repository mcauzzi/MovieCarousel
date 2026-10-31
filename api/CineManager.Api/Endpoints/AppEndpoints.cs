using System.Globalization;
using System.Security.Claims;
using System.Text.Json;
using CineManager.Api.Auth;
using CineManager.Api.Data;
using CineManager.Api.Import;
using CineManager.Api.Infrastructure;
using CineManager.Api.Lookup;
using CineManager.Api.Movies;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace CineManager.Api.Endpoints;

public sealed record AppUser(string Name);

public sealed record AppMeResponse(Guid DeviceId, string DeviceName, AppUser User);

public sealed record SearchResponse(IReadOnlyList<LookupCandidate> Candidates);

/// <summary>Endpoint dell'app Android, tutti con richiesta firmata (§4.2, §6.3); <c>pair</c> è in <see cref="PairingEndpoints"/>.</summary>
public static class AppEndpoints
{
    public static void MapAppEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/app")
            .RequireAuthorization(Policies.Device)
            .WithMetadata(new RequestSizeLimitAttribute(DeviceAuthHandler.MaxBodyBytes));

        g.MapGet("/me", (ClaimsPrincipal user) => new AppMeResponse(DeviceId(user),
            user.FindFirst(CmClaims.DeviceName)?.Value ?? "", new AppUser(user.FindFirst(CmClaims.Name)?.Value ?? "")));

        // "Scollega" dal telefono: il dispositivo si revoca da solo.
        g.MapDelete("/me", async (ClaimsPrincipal user, CinemaDbContext db, TimeProvider clock, CancellationToken ct) =>
        {
            var id = DeviceId(user);
            var now = clock.GetUtcNow();
            await db.Devices.Where(d => d.Id == id && d.RevokedAt == null)
                .ExecuteUpdateAsync(s => s.SetProperty(d => d.RevokedAt, now), ct);
            return Results.NoContent();
        });

        // Campi del modulo (inclusi i personalizzati), stessa forma di CollectionField. Escluso il
        // campo codice a barre: l'app lo invia in "ean" (nel corpo di movies verrebbe rifiutato).
        g.MapGet("/fields", async (CinemaDbContext db, IOptions<TellicoOptions> tellico, CancellationToken ct) =>
            (await FieldCatalog.LoadAsync(db, ct))
                .Where(f => f.InForm && f.Type is not (FieldTypes.Image or FieldTypes.Dependent) &&
                            f.Name != tellico.Value.BarcodeField)
                .Select(FieldEndpoints.ToDto).ToList());

        g.MapGet("/lookup", async (string? ean, MovieLookupService lookup, CancellationToken ct) =>
        {
            var normalized = EanNormalizer.Normalize(ean);
            if (ean is null || ean.Length > 32 || normalized is null || !MovieValidator.IsValidEan(normalized))
                return Bad("'ean' non valido (8–14 cifre).");
            return Results.Ok(await lookup.LookupAsync(normalized, ct));
        });

        g.MapGet("/search", async (string? q, string? year, MovieLookupService lookup, CancellationToken ct) =>
        {
            var query = q?.Trim() ?? "";
            if (query.Length is 0 or > 200) return Bad("'q' obbligatorio (al massimo 200 caratteri).");
            int? y = null;
            if (!string.IsNullOrWhiteSpace(year))
            {
                if (!int.TryParse(year, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) || parsed is < 1870 or > 2200)
                    return Bad("'year' non valido.");
                y = parsed;
            }
            return await Tmdb(async () => Results.Ok(new SearchResponse(await lookup.SearchAsync(query, y, ct))));
        });

        g.MapGet("/tmdb/{tmdbId:int}", async (int tmdbId, MovieLookupService lookup, CancellationToken ct) =>
        {
            if (tmdbId <= 0) return Bad("tmdbId non valido.");
            return await Tmdb(async () => await lookup.DraftAsync(tmdbId, ct) is { } draft
                ? Results.Ok(draft)
                : Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "Film TMDb inesistente"));
        });

        g.MapPost("/movies", async (JsonElement body, ClaimsPrincipal user, ArrivalService arrivals, CancellationToken ct) =>
        {
            var outcome = await arrivals.CreateAsync(body, user.FindFirst(CmClaims.Sub)!.Value, DeviceId(user), ct);
            return outcome is ArrivalOutcome.Created c
                ? Results.Created($"/api/movies/{c.Id}", new { id = c.Id })
                : ArrivalEndpoints.ToResult(outcome);
        });
    }

    private static Guid DeviceId(ClaimsPrincipal user) => Guid.Parse(user.FindFirst(CmClaims.Device)!.Value);

    private static async Task<IResult> Tmdb(Func<Task<IResult>> action)
    {
        try { return await action(); }
        catch (TmdbUnavailableException)
        {
            return Results.Problem(statusCode: StatusCodes.Status503ServiceUnavailable, title: "TMDb non configurato",
                detail: "Manca Tmdb__ApiToken.");
        }
        catch (TmdbException ex)
        {
            return Results.Problem(statusCode: StatusCodes.Status502BadGateway, title: "TMDb non disponibile", detail: ex.Message);
        }
    }

    private static IResult Bad(string detail) =>
        Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: "Richiesta non valida", detail: detail);
}
