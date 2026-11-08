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

/// <summary>
/// Sezione <c>Auth</c>: autenticazione finta per lo sviluppo locale (§10.2) e, valida anche in
/// produzione, la durata della cache del timbro di sicurezza.
/// </summary>
public sealed class DevAuthOptions
{
    public const string Section = "Auth";
    public string? DevUser { get; set; }
    /// <summary>Ruoli separati da virgola, es. <c>user,admin</c>.</summary>
    public string? DevRoles { get; set; }
    /// <summary>
    /// Durata della cache del timbro di sicurezza (secondi; <c>Auth__StampCacheSeconds</c>). Vale in
    /// ogni ambiente, non solo con <see cref="DevUser"/>; 0 = rilettura dal DB a ogni richiesta.
    /// </summary>
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

/// <summary>Sezione <c>Devices</c>: telefoni abbinati (§4.2, §4.3).</summary>
public sealed class DevicesOptions
{
    public const string Section = "Devices";
    /// <summary>Giorni massimi dall'ultimo login sul sito del proprietario perché il telefono resti valido.</summary>
    public int MaxOwnerInactiveDays { get; set; } = 90;
}

/// <summary>Sezione <c>App</c>: versione dell'app Android (§11.1).</summary>
public sealed class AppOptions
{
    public const string Section = "App";
    /// <summary>URL di <c>version.json</c> (nello stack <c>http://web/app/version.json</c>); vuoto ⇒ nessun controllo 426.</summary>
    public string? VersionUrl { get; set; }
}

/// <summary>Sezione <c>Lookup</c>: catena dei provider di codici a barre (§7).</summary>
public sealed class LookupOptions
{
    public const string Section = "Lookup";
    /// <summary>Nomi dei provider in ordine, separati da virgola (default <c>upcitemdb</c>).</summary>
    public string Providers { get; set; } = "upcitemdb";
    /// <summary>Chiave UPCitemdb facoltativa: senza si usa l'endpoint di prova gratuito.</summary>
    public string? UpcItemDbKey { get; set; }
}

/// <summary>Sezione <c>Tmdb</c> (§7).</summary>
public sealed class TmdbOptions
{
    public const string Section = "Tmdb";
    /// <summary>Token di lettura v4 (bearer). Vuoto ⇒ ricerca TMDb non disponibile.</summary>
    public string? ApiToken { get; set; }
}
