using CineManager.Api.Auth;
using CineManager.Api.Import;
using CineManager.Api.Infrastructure;
using Microsoft.AspNetCore.Mvc;

namespace CineManager.Api.Endpoints;

public static class ImportEndpoints
{
    /// <summary>Corpo massimo per gli import (§6, Limiti); lo stesso valore va in nginx.</summary>
    public const long MaxImportBody = 32L * 1024 * 1024;

    public static void MapImportEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/import/tellico").RequireAuthorization(Policies.Admin);

        group.MapPost("/images", async (ImagesImportRequest req, CoverStore covers, CancellationToken ct) =>
        {
            if (req.Images is null) return Bad("'images' mancante.");
            try { return Results.Ok(await covers.WriteAsync(req.Images, ct)); }
            catch (ImportValidationException ex) { return Bad(ex.Message); }
        }).WithMetadata(new RequestSizeLimitAttribute(MaxImportBody));

        group.MapPost("", async (TellicoImportRequest req, TellicoImporter importer, CancellationToken ct) =>
        {
            try { return Results.Ok(await importer.ImportAsync(req, ct)); }
            catch (ImportValidationException ex) { return Bad(ex.Message); }
        }).WithMetadata(new RequestSizeLimitAttribute(MaxImportBody));
    }

    private static IResult Bad(string detail) => ApiResults.Bad(detail, "Import non valido");
}
