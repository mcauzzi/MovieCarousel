using System.Globalization;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using CineManager.Api.Auth;
using CineManager.Api.Data;
using CineManager.Api.Infrastructure;
using CineManager.Api.Movies;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using static CineManager.Api.Infrastructure.ApiResults;

namespace CineManager.Api.Endpoints;

public sealed record MarkResponse(int Marked);

/// <summary>Arrivi dall'app, loro correzione/eliminazione ed ESPORTA CSV (§6.2, §9).</summary>
public static partial class ArrivalEndpoints
{
    public const string CutoffHeader = "X-CM-Export-Cutoff";
    public const string CountHeader = "X-CM-Export-Count";
    private static readonly string[] Scopes = ["new", "app", "all"];

    public static void MapArrivalEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/arrivals", async (string? scope, ClaimsPrincipal user, ArrivalService arrivals, CancellationToken ct) =>
        {
            scope ??= "new";
            if (scope is not ("new" or "app")) return Bad("'scope' deve essere new o app.");
            return Results.Ok(await arrivals.ListAsync(scope, user.Sub(), user.IsInRole(Roles.Admin), ct));
        }).RequireAuthorization(Policies.User);

        app.MapPatch("/api/movies/{id:int}", async (int id, JsonElement body, ClaimsPrincipal user, ArrivalService arrivals,
            CancellationToken ct) => ToResult(await arrivals.PatchAsync(id, body, user.Sub(), user.IsInRole(Roles.Admin), ct)))
            .RequireAuthorization(Policies.User);

        app.MapDelete("/api/movies/{id:int}", async (int id, ClaimsPrincipal user, ArrivalService arrivals, CancellationToken ct) =>
            ToResult(await arrivals.DeleteAsync(id, user.Sub(), user.IsInRole(Roles.Admin), ct)))
            .RequireAuthorization(Policies.User);

        // L'export non modifica nulla: il sito poi chiama /mark con lo stesso scope e il cutoff ricevuto.
        app.MapGet("/api/export/csv", async (string? scope, HttpContext ctx, CinemaDbContext db,
            IOptions<TellicoOptions> tellico, TimeProvider clock, CancellationToken ct) =>
        {
            scope ??= "new";
            if (!Scopes.Contains(scope)) return Bad("'scope' deve essere new, app o all.");

            List<Movie> movies;
            List<CollectionField> fields;
            DateTimeOffset cutoff;
            await using (var tx = await db.Database.BeginTransactionAsync(ct))
            {
                // Esclusivo: aspetta gli arrivi in corso (lock condiviso) e blocca i nuovi finché non c'è
                // il cutoff. Ogni arrivo incluso ha created_at ≤ cutoff, ogni arrivo escluso > cutoff
                // (created_at si legge dopo aver preso il lock). Read committed: la lettura vede tutto
                // ciò che è stato confermato prima di ottenere il lock.
                await CollectionLock.ExclusiveAsync(db, ct);
                var q = db.Movies.AsNoTracking();
                q = scope switch
                {
                    "new" => q.Where(m => m.Source == MovieSources.App && m.ExportedAt == null),
                    "app" => q.Where(m => m.Source == MovieSources.App),
                    _ => q,
                };
                movies = await q.OrderBy(m => m.Id).ToListAsync(ct);
                fields = await FieldCatalog.LoadAsync(db, ct);
                cutoff = TruncateToMicroseconds(clock.GetUtcNow());
                await tx.CommitAsync(ct);
            }
            var csv = CsvExporter.Write(fields, tellico.Value.BarcodeField,
                movies.Select(m => new CsvExporter.Row(m.Ean, JsonNode.Parse(m.Data) as JsonObject ?? new JsonObject())));

            var file = $"cinemanager-{scope}-{clock.GetLocalNow():yyyyMMdd-HHmm}.csv";
            ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"{file}\"";
            ctx.Response.Headers[CutoffHeader] = FormatCutoff(cutoff);
            ctx.Response.Headers[CountHeader] =
                movies.Count(m => m.Source == MovieSources.App).ToString(CultureInfo.InvariantCulture);
            ctx.Response.Headers.AccessControlExposeHeaders = $"{CutoffHeader}, {CountHeader}, Content-Disposition";
            return Results.Text(csv, "text/csv; charset=utf-8", new UTF8Encoding(false));
        }).RequireAuthorization(Policies.Admin);

        // Marca come esportati gli arrivi dello scope creati fino al cutoff dell'export (compreso).
        app.MapPost("/api/export/mark", async (JsonElement body, CinemaDbContext db, TimeProvider clock, CancellationToken ct) =>
        {
            if (body.ValueKind != JsonValueKind.Object) return Bad("Serve { scope, cutoff }.");
            foreach (var p in body.EnumerateObject())
                if (p.Name is not ("scope" or "cutoff")) return Bad($"Proprietà sconosciuta: '{p.Name}'.");
            var scope = body.TryGetProperty("scope", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() : null;
            if (scope == "all") return Bad("Lo scope all non si marca: si marcano solo gli export new o app.");
            if (scope is not ("new" or "app")) return Bad("'scope' deve essere new o app.");
            if (!body.TryGetProperty("cutoff", out var c) || c.ValueKind != JsonValueKind.String ||
                !TryParseCutoff(c.GetString()!, out var cutoff))
                return Bad("'cutoff' deve essere il valore di X-CM-Export-Cutoff (ISO 8601, es. 2026-10-31T10:15:30.123456Z).");
            var now = clock.GetUtcNow();
            if (cutoff > now) return Bad("'cutoff' è nel futuro.");

            var q = db.Movies.Where(m => m.Source == MovieSources.App && m.CreatedAt <= cutoff);
            if (scope == "new") q = q.Where(m => m.ExportedAt == null);
            var marked = await q.ExecuteUpdateAsync(u => u.SetProperty(m => m.ExportedAt, now), ct);
            return Results.Ok(new MarkResponse(marked));
        }).RequireAuthorization(Policies.Admin);
    }

    /// <summary>Precisione di Postgres (microsecondi), così il cutoff confrontato con created_at è esatto.</summary>
    private static DateTimeOffset TruncateToMicroseconds(DateTimeOffset t) =>
        new(t.UtcTicks - t.UtcTicks % 10, TimeSpan.Zero);

    public static string FormatCutoff(DateTimeOffset t) =>
        t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'", CultureInfo.InvariantCulture);

    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$")]
    private static partial Regex IsoRegex();

    private static bool TryParseCutoff(string s, out DateTimeOffset cutoff)
    {
        cutoff = default;
        if (!IsoRegex().IsMatch(s) ||
            !DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal, out var parsed))
            return false;
        cutoff = parsed.ToUniversalTime();
        return true;
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

}
