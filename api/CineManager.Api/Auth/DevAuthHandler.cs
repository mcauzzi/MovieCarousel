using System.Collections.Concurrent;
using System.Security.Claims;
using System.Text.Encodings.Web;
using CineManager.Api.Infrastructure;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace CineManager.Api.Auth;

/// <summary>
/// Autenticazione finta per lo sviluppo locale (§10.2): ogni richiesta è dell'utente
/// <c>Auth__DevUser</c> con i ruoli <c>Auth__DevRoles</c>. Registrata solo in Development.
/// </summary>
public sealed class DevAuthHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    IOptions<DevAuthOptions> dev,
    DevUserSyncState synced) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "Dev";

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var sub = dev.Value.DevUser!;
        var roles = Roles.ParseDevRoles(dev.Value.DevRoles);
        await synced.EnsureAsync(sub, () =>
            Context.RequestServices.GetRequiredService<UserSync>().UpsertAsync(sub, sub, sub, roles.ToArray()));

        var identity = new ClaimsIdentity(SchemeName, CmClaims.Name, CmClaims.Role);
        identity.AddClaim(new Claim(CmClaims.Sub, sub));
        identity.AddClaim(new Claim(CmClaims.Name, sub));
        identity.AddClaim(new Claim(CmClaims.Username, sub));
        foreach (var r in roles) identity.AddClaim(new Claim(CmClaims.Role, r));
        return AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName));
    }
}

/// <summary>L'upsert in <c>users</c> dell'utente di sviluppo serve una volta per processo.</summary>
public sealed class DevUserSyncState
{
    private readonly ConcurrentDictionary<string, Lazy<Task>> _done = new();

    public async Task EnsureAsync(string sub, Func<Task> sync)
    {
        var lazy = _done.GetOrAdd(sub, _ => new Lazy<Task>(sync));
        try { await lazy.Value; }
        catch
        {
            _done.TryRemove(new KeyValuePair<string, Lazy<Task>>(sub, lazy)); // si riprova alla prossima richiesta
            throw;
        }
    }
}
