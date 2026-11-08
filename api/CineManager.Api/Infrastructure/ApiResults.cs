using System.Security.Claims;
using CineManager.Api.Auth;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace CineManager.Api.Infrastructure;

/// <summary>Risposte e letture comuni agli endpoint.</summary>
public static class ApiResults
{
    /// <summary>400 problem+json con <paramref name="detail"/>.</summary>
    public static IResult Bad(string detail, string title = "Richiesta non valida") =>
        Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: title, detail: detail);

    /// <summary><c>sub</c> dell'utente autenticato (sito o proprietario del dispositivo).</summary>
    public static string Sub(this ClaimsPrincipal user) => user.FindFirst(CmClaims.Sub)!.Value;

    /// <summary>Violazione di un vincolo unique (di <paramref name="constraint"/>, se indicato).</summary>
    public static bool IsUniqueViolation(this DbUpdateException ex, string? constraint = null) =>
        ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation } pg &&
        (constraint is null || pg.ConstraintName == constraint);
}
