namespace CineManager.Api.Infrastructure;

/// <summary>
/// CSRF (§4.1): ogni richiesta che modifica dati verso gli endpoint del sito (autenticati col
/// cookie) deve portare <c>X-CM-Request: 1</c>. Un header personalizzato impone il preflight
/// CORS, e senza CORS abilitato un sito terzo non può inviarlo. Escluse <c>/api/app/*</c>
/// (richieste firmate dal telefono, fase 3) e la callback OIDC.
/// </summary>
public sealed class CsrfMiddleware(RequestDelegate next)
{
    public const string HeaderName = "X-CM-Request";

    public async Task InvokeAsync(HttpContext ctx)
    {
        if (RequiresHeader(ctx.Request) && ctx.Request.Headers[HeaderName] != "1")
        {
            await Results.Problem(statusCode: StatusCodes.Status400BadRequest,
                title: "Header X-CM-Request mancante",
                detail: "Le richieste che modificano dati devono includere l'header X-CM-Request: 1.")
                .ExecuteAsync(ctx);
            return;
        }
        await next(ctx);
    }

    private static bool RequiresHeader(HttpRequest req)
    {
        if (HttpMethods.IsGet(req.Method) || HttpMethods.IsHead(req.Method) ||
            HttpMethods.IsOptions(req.Method) || HttpMethods.IsTrace(req.Method))
            return false;
        var path = req.Path;
        if (!path.StartsWithSegments("/api", StringComparison.OrdinalIgnoreCase)) return false;
        if (path.StartsWithSegments("/api/app", StringComparison.OrdinalIgnoreCase)) return false;
        if (path.Equals(Auth.AuthSetup.CallbackPath, StringComparison.OrdinalIgnoreCase)) return false;
        return true;
    }
}
