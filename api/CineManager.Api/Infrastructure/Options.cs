namespace CineManager.Api.Infrastructure;

/// <summary>Sezione <c>Oidc</c>: client confidenziale verso Authelia (§4.1, §4.3).</summary>
public sealed class OidcOptions
{
    public const string Section = "Oidc";
    public string? Authority { get; set; }
    public string? ClientId { get; set; }
    public string? ClientSecret { get; set; }
    /// <summary>Gruppo che dà il ruolo "user"; vuoto ⇒ ogni utente autenticato è "user".</summary>
    public string? UserGroup { get; set; }
    /// <summary>Gruppo che dà il ruolo "admin" (richiede anche il ruolo "user").</summary>
    public string? AdminGroup { get; set; }
    public bool RequireHttpsMetadata { get; set; } = true;

    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(Authority) && !string.IsNullOrWhiteSpace(ClientId) &&
        !string.IsNullOrWhiteSpace(ClientSecret);
}

/// <summary>Sezione <c>Auth</c>: autenticazione finta per lo sviluppo locale (§10.2).</summary>
public sealed class DevAuthOptions
{
    public const string Section = "Auth";
    public string? DevUser { get; set; }
    /// <summary>Ruoli separati da virgola, es. <c>user,admin</c>.</summary>
    public string? DevRoles { get; set; }
    /// <summary>Durata della cache del timbro di sicurezza (secondi).</summary>
    public int StampCacheSeconds { get; set; } = 60;
}

/// <summary>Sezione <c>Covers</c>: cartella delle copertine (unico mount in scrittura).</summary>
public sealed class CoversOptions
{
    public const string Section = "Covers";
    public string? Path { get; set; }
}

/// <summary>Sezione <c>Tellico</c>.</summary>
public sealed class TellicoOptions
{
    public const string Section = "Tellico";
    /// <summary>Nome del campo codice a barre nel <c>.tc</c> (§8, §9).</summary>
    public string BarcodeField { get; set; } = "ean";
}
