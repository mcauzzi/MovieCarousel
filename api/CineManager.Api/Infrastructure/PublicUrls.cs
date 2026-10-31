using QRCoder;

namespace CineManager.Api.Infrastructure;

/// <summary>Indirizzo pubblico del sito e QR in SVG (§10, "Il QR").</summary>
public static class PublicUrls
{
    /// <summary>
    /// <c>PublicBaseUrl</c> senza barra finale; in Development, se manca, l'origine della richiesta
    /// (sviluppo locale). Null fuori da Development senza configurazione.
    /// </summary>
    public static string? Base(HttpContext ctx)
    {
        var cfg = ctx.RequestServices.GetRequiredService<IConfiguration>();
        var configured = cfg["PublicBaseUrl"]?.Trim().TrimEnd('/');
        if (!string.IsNullOrEmpty(configured) && Uri.TryCreate(configured, UriKind.Absolute, out _)) return configured;
        if (ctx.RequestServices.GetRequiredService<IWebHostEnvironment>().IsDevelopment())
            return $"{ctx.Request.Scheme}://{ctx.Request.Host}";
        return null;
    }

    public static IResult NotConfigured() => Results.Problem(statusCode: StatusCodes.Status503ServiceUnavailable,
        title: "PublicBaseUrl non configurato", detail: "Serve l'indirizzo pubblico del sito per costruire il QR.");

    /// <summary>QR come documento SVG scalabile (viewBox), correzione d'errore M.</summary>
    public static string QrSvg(string text)
    {
        using var gen = new QRCodeGenerator();
        using var data = gen.CreateQrCode(text, QRCodeGenerator.ECCLevel.M);
        return new SvgQRCode(data).GetGraphic(8, "#000000", "#ffffff", true, SvgQRCode.SizingMode.ViewBoxAttribute);
    }
}
