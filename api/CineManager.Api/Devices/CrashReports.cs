using System.Security.Claims;
using CineManager.Api.Auth;
using static CineManager.Api.Infrastructure.ApiResults;

namespace CineManager.Api.Devices;

/// <summary>Segnalazione di crash dell'app (docs/api.md, <c>POST /api/app/crash</c>).</summary>
public sealed record CrashReportDto(
    string? Kind,
    DateTimeOffset? OccurredAt,
    int? AppVersionCode,
    string? AppVersion,
    string? Device,
    string? Android,
    string? Thread,
    string? Exception,
    string? Message,
    string? StackTrace);

public sealed record CrashReportBatch(List<CrashReportDto?>? Reports);

/// <summary>
/// Crash dell'app inviati dal telefono al riavvio successivo: non vengono salvati nel DB, finiscono
/// nei log (categoria <c>CineManager.AppCrash</c>, livello Error) e quindi, con la telemetria
/// attiva, in Loki con i campi strutturati. I testi troppo lunghi vengono troncati invece di
/// rifiutare la segnalazione: un 400 la farebbe scartare dal telefono.
/// </summary>
public static class CrashReports
{
    public const int MaxReports = 10;
    public const string LogCategory = "CineManager.AppCrash";
    private const int ShortMax = 200, MessageMax = 2_000, StackMax = 64 * 1024;
    private static readonly HashSet<string> Kinds = ["crash", "anr", "native"];

    public static IResult Handle(CrashReportBatch? batch, ClaimsPrincipal user, ILoggerFactory loggers)
    {
        var reports = batch?.Reports;
        if (reports is null || reports.Count is 0 or > MaxReports || reports.Any(r => r is null))
            return Bad($"'reports': da 1 a {MaxReports} segnalazioni.");

        var log = loggers.CreateLogger(LogCategory);
        var device = user.FindFirst(CmClaims.Device)?.Value;
        var deviceName = user.FindFirst(CmClaims.DeviceName)?.Value;
        foreach (var r in reports)
        {
            var kind = Clean(r!.Kind, ShortMax)?.ToLowerInvariant() is { } k && Kinds.Contains(k) ? k : "other";
            using var scope = log.BeginScope(new Dictionary<string, object?>
            {
                ["DeviceName"] = deviceName,
                ["DeviceModel"] = Clean(r.Device, ShortMax),
                ["Android"] = Clean(r.Android, ShortMax),
                ["AppVersion"] = Clean(r.AppVersion, ShortMax),
                ["Thread"] = Clean(r.Thread, ShortMax),
                ["OccurredAt"] = r.OccurredAt,
            });
            log.LogError("Crash dell'app ({Kind}) sul dispositivo {Device} di {Sub}, versione {AppVersionCode}: {ExceptionType}: {ExceptionMessage}\n{StackTrace}",
                kind, device, user.Sub(), r.AppVersionCode,
                Clean(r.Exception, ShortMax) ?? "?", Clean(r.Message, MessageMax) ?? "", Clean(r.StackTrace, StackMax) ?? "");
        }
        return Results.NoContent();
    }

    /// <summary>Senza NUL, troncato a <paramref name="max"/> caratteri; vuoto → null.</summary>
    internal static string? Clean(string? s, int max)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        s = s.Replace("\0", "");
        return s.Length <= max ? s : s[..max] + "…[troncato]";
    }
}
