using System.Globalization;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CineManager.Api.Auth;
using CineManager.Api.Data;
using CineManager.Api.Infrastructure;
using CineManager.Api.Movies;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace CineManager.Api.Endpoints;

public sealed record MarkResponse(int Marked);

/// <summary>Arrivi dall'app, loro correzione/eliminazione ed ESPORTA CSV (§6.2, §9).</summary>
public static class ArrivalEndpoints
{
    public const string MovieIdsHeader = "X-CM-Movie-Ids";
    private static readonly string[] Scopes = ["new", "app", "all"];

    public static void MapArrivalEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/arrivals", async (string? scope, ClaimsPrincipal user, ArrivalService arrivals, CancellationToken ct) =>
        {
            scope ??= "new";
            if (scope is not ("new" or "app")) return Bad("'scope' deve essere new o app.");
            return Results.Ok(await arrivals.ListAsync(scope, Sub(user), user.IsInRole(Roles.Admin), ct));
        }).RequireAuthorization(Policies.User);

        app.MapPatch("/api/movies/{id:int}", async (int id, JsonElement body, ClaimsPrincipal user, ArrivalService arrivals,
            CancellationToken ct) => ToResult(await arrivals.PatchAsync(id, body, Sub(user), user.IsInRole(Roles.Admin), ct)))
            .RequireAuthorization(Policies.User);

        app.MapDelete("/api/movies/{id:int}", async (int id, ClaimsPrincipal user, ArrivalService arrivals, CancellationToken ct) =>
            ToResult(await arrivals.DeleteAsync(id, Sub(user), user.IsInRole(Roles.Admin), ct)))
            .RequireAuthorization(Policies.User);

        // L'export non modifica nulla: gli id inclusi viaggiano nell'header, il sito poi chiama /mark.
        app.MapPost("/api/export/csv", async (HttpContext ctx, JsonElement? body, CinemaDbContext db,
            IOptions<TellicoOptions> tellico, TimeProvider clock, CancellationToken ct) =>
        {
            var scope = "new";
            if (body is { ValueKind: JsonValueKind.Object } b && b.TryGetProperty("scope", out var s) && s.ValueKind != JsonValueKind.Null)
            {
                scope = s.ValueKind == JsonValueKind.String ? s.GetString()! : "";
                if (!Scopes.Contains(scope)) return Bad("'scope' deve essere new, app o all.");
            }
            else if (body is { ValueKind: not (JsonValueKind.Object or JsonValueKind.Undefined or JsonValueKind.Null) })
                return Bad("Il corpo deve essere un oggetto JSON.");

            var q = db.Movies.AsNoTracking();
            q = scope switch
            {
                "new" => q.Where(m => m.Source == MovieSources.App && m.ExportedAt == null),
                "app" => q.Where(m => m.Source == MovieSources.App),
                _ => q,
            };
            var movies = await q.OrderBy(m => m.Id).ToListAsync(ct);
            var fields = await FieldCatalog.LoadAsync(db, ct);
            var csv = CsvExporter.Write(fields, tellico.Value.BarcodeField,
                movies.Select(m => new CsvExporter.Row(m.Ean, JsonNode.Parse(m.Data) as JsonObject ?? new JsonObject())));

            // Per "all" l'header elenca solo gli arrivi dall'app (gli unici per cui ha senso /mark):
            // con migliaia di id l'header supererebbe i buffer dei proxy.
            var ids = movies.Where(m => scope != "all" || m.Source == MovieSources.App)
                .Select(m => m.Id.ToString(CultureInfo.InvariantCulture));
            var file = $"cinemanager-{scope}-{clock.GetLocalNow():yyyyMMdd-HHmm}.csv";
            ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"{file}\"";
            ctx.Response.Headers[MovieIdsHeader] = string.Join(',', ids);
            ctx.Response.Headers.AccessControlExposeHeaders = MovieIdsHeader + ", Content-Disposition";
            return Results.Text(csv, "text/csv; charset=utf-8", new UTF8Encoding(false));
        }).RequireAuthorization(Policies.Admin);

        app.MapPost("/api/export/mark", async (JsonElement body, CinemaDbContext db, TimeProvider clock, CancellationToken ct) =>
        {
            if (body.ValueKind != JsonValueKind.Object || !body.TryGetProperty("ids", out var idsEl) ||
                idsEl.ValueKind != JsonValueKind.Array)
                return Bad("Serve { ids: [..] }.");
            var ids = new List<int>();
            foreach (var el in idsEl.EnumerateArray())
            {
                if (el.ValueKind != JsonValueKind.Number || !el.TryGetInt32(out var id)) return Bad("'ids' deve contenere interi.");
                ids.Add(id);
            }
            if (ids.Count == 0) return Results.Ok(new MarkResponse(0));
            var now = clock.GetUtcNow();
            var distinct = ids.Distinct().ToList();
            var marked = await db.Movies.Where(m => distinct.Contains(m.Id))
                .ExecuteUpdateAsync(s => s.SetProperty(m => m.ExportedAt, now), ct);
            return Results.Ok(new MarkResponse(marked));
        }).RequireAuthorization(Policies.Admin);
    }

    /// <summary>Traduzione HTTP degli esiti di <see cref="ArrivalService"/>.</summary>
    public static IResult ToResult(ArrivalOutcome outcome) => outcome switch
    {
        ArrivalOutcome.Updated u => Results.Ok(u.Arrival),
        ArrivalOutcome.Deleted => Results.NoContent(),
        ArrivalOutcome.Created c => Results.Created($"/api/movies/{c.Id}", new { id = c.Id }),
        ArrivalOutcome.Invalid { Errors: { } errors } i => Results.ValidationProblem(errors, i.Detail, title: "Campi non validi"),
        ArrivalOutcome.Invalid i => Bad(i.Detail),
        // Corpi di 409 come nel contratto (§6.3): JSON semplice, non problem+json ("title" è il titolo del film).
        ArrivalOutcome.EanConflict e => Results.Json(new { reason = "ean", existingId = e.ExistingId, title = e.Title },
            statusCode: StatusCodes.Status409Conflict),
        ArrivalOutcome.PossibleDuplicate d => Results.Json(new { reason = "possible_duplicate", candidates = d.Candidates },
            statusCode: StatusCodes.Status409Conflict),
        ArrivalOutcome.NotFound => Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "Film inesistente"),
        ArrivalOutcome.Forbidden => Results.Problem(statusCode: StatusCodes.Status403Forbidden, title: "Non è un tuo arrivo"),
        ArrivalOutcome.NotAnArrival => Results.Problem(statusCode: StatusCodes.Status409Conflict,
            title: "Non è un arrivo dall'app", detail: "Si possono correggere o eliminare solo i film con source = app."),
        _ => throw new InvalidOperationException("Esito sconosciuto: " + outcome),
    };

    private static string Sub(ClaimsPrincipal user) => user.FindFirst(CmClaims.Sub)!.Value;

    private static IResult Bad(string detail) =>
        Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: "Richiesta non valida", detail: detail);
}
