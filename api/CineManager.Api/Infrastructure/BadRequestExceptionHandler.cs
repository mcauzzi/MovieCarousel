using Microsoft.AspNetCore.Diagnostics;

namespace CineManager.Api.Infrastructure;

/// <summary>
/// Body non leggibile (JSON non valido, tipi sbagliati, Content-Type mancante…): le Minimal API
/// lanciano <see cref="BadHttpRequestException"/> (in Development) che senza questo handler
/// diventerebbe un 500. Risponde con il suo codice (400, 415…) in problem+json, in ogni ambiente.
/// </summary>
public sealed class BadRequestExceptionHandler(IProblemDetailsService problems, ILogger<BadRequestExceptionHandler> log)
    : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext ctx, Exception exception, CancellationToken ct)
    {
        if (exception is not BadHttpRequestException bad) return false;
        log.LogInformation("Richiesta non valida ({Status}): {Message}", bad.StatusCode, bad.Message);
        ctx.Response.StatusCode = bad.StatusCode;
        return await problems.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = ctx,
            Exception = exception,
            ProblemDetails =
            {
                Status = bad.StatusCode,
                Title = bad.StatusCode == StatusCodes.Status415UnsupportedMediaType
                    ? "Content-Type non supportato" : "Richiesta non valida",
                // Il messaggio dice quale parametro non si legge, senza contenuti del body.
                Detail = bad.Message,
            },
        });
    }
}
