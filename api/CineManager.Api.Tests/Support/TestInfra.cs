using System.Security.Claims;
using System.Text.Encodings.Web;
using CineManager.Api.Auth;
using CineManager.Api.Data;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Npgsql;

namespace CineManager.Api.Tests.Support;

/// <summary>
/// Test che richiede Postgres: saltato se <c>CINEMA_TEST_CONNECTION</c> non è impostata
/// (es. <c>Host=localhost;Username=cinema;Password=cinema</c>, ruolo con CREATEDB).
/// </summary>
public sealed class DbFactAttribute : FactAttribute
{
    public DbFactAttribute()
    {
        if (TestDb.BaseConnection is null)
            Skip = "CINEMA_TEST_CONNECTION non impostata: test d'integrazione con Postgres saltato.";
    }
}

public sealed class DbTheoryAttribute : TheoryAttribute
{
    public DbTheoryAttribute()
    {
        if (TestDb.BaseConnection is null)
            Skip = "CINEMA_TEST_CONNECTION non impostata: test d'integrazione con Postgres saltato.";
    }
}

public static class TestDb
{
    public static string? BaseConnection =>
        Environment.GetEnvironmentVariable("CINEMA_TEST_CONNECTION") is { Length: > 0 } s ? s : null;

    /// <summary>Connection string verso un database nuovo con nome univoco (creato dalle migrazioni).</summary>
    public static string NewDatabase()
    {
        var b = new NpgsqlConnectionStringBuilder(BaseConnection ?? "Host=localhost") { Database = $"cm_test_{Guid.NewGuid():N}" };
        return b.ConnectionString;
    }

    public static void Drop(string connectionString)
    {
        var target = new NpgsqlConnectionStringBuilder(connectionString);
        NpgsqlConnection.ClearAllPools();
        var admin = new NpgsqlConnectionStringBuilder(connectionString) { Database = "postgres", Pooling = false };
        using var conn = new NpgsqlConnection(admin.ConnectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"DROP DATABASE IF EXISTS \"{target.Database}\" WITH (FORCE)";
        cmd.ExecuteNonQuery();
    }
}

/// <summary>
/// Host dell'API su un database dedicato, distrutto al Dispose. Di default ambiente Development
/// con autenticazione di test (header <c>X-Test-User</c>/<c>X-Test-Roles</c>).
/// </summary>
public class ApiFactory : WebApplicationFactory<Program>
{
    public string ConnectionString { get; } = TestDb.NewDatabase();
    public string CoversPath { get; } = Path.Combine(Path.GetTempPath(), "cm-test-covers-" + Guid.NewGuid().ToString("N"));
    public string Environment { get; init; } = "Development";
    public bool UseTestAuth { get; init; } = true;
    public Dictionary<string, string?> Settings { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment(Environment);
        builder.UseSetting("ConnectionStrings:Cinema", ConnectionString);
        builder.UseSetting("Covers:Path", CoversPath);
        builder.UseSetting("RateLimit:PerMinute", "100000");
        foreach (var (k, v) in Settings) builder.UseSetting(k, v);
        builder.ConfigureLogging(l => l.SetMinimumLevel(LogLevel.Warning));
        if (UseTestAuth)
        {
            builder.ConfigureTestServices(s =>
            {
                s.AddAuthentication(o =>
                {
                    o.DefaultScheme = TestAuthHandler.SchemeName;
                    o.DefaultChallengeScheme = TestAuthHandler.SchemeName;
                    o.DefaultForbidScheme = TestAuthHandler.SchemeName;
                }).AddScheme<AuthenticationSchemeOptions, TestAuthHandler>(TestAuthHandler.SchemeName, _ => { });
            });
        }
    }

    /// <summary>Client con l'utente di test indicato (nessun utente = richiesta anonima).</summary>
    public HttpClient Client(string? user = "alice", string roles = "user", bool csrf = true)
    {
        var c = CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, HandleCookies = false });
        if (user is not null)
        {
            c.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, user);
            c.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, roles);
        }
        if (csrf) c.DefaultRequestHeaders.Add("X-CM-Request", "1");
        return c;
    }

    public async Task WithDbAsync(Func<CinemaDbContext, Task> action)
    {
        using var scope = Services.CreateScope();
        await action(scope.ServiceProvider.GetRequiredService<CinemaDbContext>());
    }

    public async Task<T> WithDbAsync<T>(Func<CinemaDbContext, Task<T>> action)
    {
        using var scope = Services.CreateScope();
        return await action(scope.ServiceProvider.GetRequiredService<CinemaDbContext>());
    }

    /// <summary>Svuota i dati tra un test e l'altro (gli utenti restano).</summary>
    public Task ResetAsync() => WithDbAsync(db => db.Database.ExecuteSqlRawAsync(
        "TRUNCATE movies, collection_fields, user_movie_state RESTART IDENTITY CASCADE; " +
        "ALTER SEQUENCE movies_app_id_seq RESTART WITH 1000000;"));

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (!disposing) return;
        try { TestDb.Drop(ConnectionString); } catch { /* best effort */ }
        try { if (Directory.Exists(CoversPath)) Directory.Delete(CoversPath, true); } catch { /* best effort */ }
    }
}

/// <summary>Autenticazione di test: utente e ruoli dagli header; senza header nessuna identità (→ 401).</summary>
public sealed class TestAuthHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "Test";
    public const string UserHeader = "X-Test-User";
    public const string RolesHeader = "X-Test-Roles";

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!Request.Headers.TryGetValue(UserHeader, out var userValues)) return AuthenticateResult.NoResult();
        var sub = userValues.ToString();
        var roles = Request.Headers[RolesHeader].ToString()
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        // Come al login: l'utente deve esistere in `users` (FK dello stato).
        await Context.RequestServices.GetRequiredService<UserSync>().UpsertAsync(sub, sub, sub.ToUpperInvariant(), []);
        var id = new ClaimsIdentity(SchemeName, CmClaims.Name, CmClaims.Role);
        id.AddClaim(new Claim(CmClaims.Sub, sub));
        id.AddClaim(new Claim(CmClaims.Name, sub.ToUpperInvariant()));
        foreach (var r in roles) id.AddClaim(new Claim(CmClaims.Role, r));
        return AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(id), SchemeName));
    }
}

/// <summary>Fixture di classe: un host + database per classe di test, creato solo se Postgres è disponibile.</summary>
public sealed class ApiFixture : IDisposable
{
    private readonly Lazy<ApiFactory> _factory = new(() =>
    {
        var f = new ApiFactory();
        f.CreateClient().Dispose(); // avvia l'host e applica le migrazioni
        return f;
    });

    public ApiFactory Factory => _factory.Value;

    public void Dispose()
    {
        if (_factory.IsValueCreated) _factory.Value.Dispose();
    }
}
