using Microsoft.Extensions.Configuration;
using Npgsql;

namespace CineManager.Api.Infrastructure;

/// <summary>
/// Connection string del DB con la password tenuta fuori dalla stringa: in produzione arriva da un file
/// env (<c>db.env</c>, chiave <c>POSTGRES_PASSWORD</c>, condivisa con il container di Postgres) o da
/// <c>Database__Password</c>, e viene inserita con <see cref="NpgsqlConnectionStringBuilder"/>: così
/// caratteri come <c>;</c>, <c>=</c> o apici non spezzano la connection string.
/// </summary>
public static class DbConnection
{
    public static string Build(IConfiguration configuration)
    {
        var raw = configuration.GetConnectionString("Cinema");
        if (string.IsNullOrWhiteSpace(raw))
            throw new InvalidOperationException("ConnectionStrings__Cinema mancante.");
        return WithPassword(raw, PasswordFrom(configuration));
    }

    /// <summary>Ordine: <c>Database:Password</c>, poi <c>POSTGRES_PASSWORD</c>; null se nessuna è impostata.</summary>
    public static string? PasswordFrom(IConfiguration configuration) =>
        new[] { configuration["Database:Password"], configuration["POSTGRES_PASSWORD"] }.FirstOrDefault(p => !string.IsNullOrEmpty(p));

    /// <summary>Se <paramref name="password"/> è null la stringa resta com'è (es. Development, password già dentro).</summary>
    public static string WithPassword(string connectionString, string? password) => password is null
        ? connectionString
        : new NpgsqlConnectionStringBuilder(connectionString) { Password = password }.ConnectionString;
}
