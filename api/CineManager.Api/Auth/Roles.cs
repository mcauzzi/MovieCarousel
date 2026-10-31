namespace CineManager.Api.Auth;

public static class Roles
{
    public const string User = "user";
    public const string Admin = "admin";

    /// <summary>
    /// Ruoli dai gruppi ricevuti al login (§4.3): "user" se <paramref name="userGroup"/> è vuoto o
    /// presente tra i gruppi; "admin" se in più c'è <paramref name="adminGroup"/>. Un membro del
    /// solo gruppo admin, senza il gruppo utenti, non riceve alcun ruolo.
    /// </summary>
    public static IReadOnlyList<string> Resolve(IEnumerable<string> groups, string? userGroup, string? adminGroup)
    {
        var set = new HashSet<string>(groups, StringComparer.Ordinal);
        var isUser = string.IsNullOrWhiteSpace(userGroup) || set.Contains(userGroup.Trim());
        if (!isUser) return [];
        var isAdmin = !string.IsNullOrWhiteSpace(adminGroup) && set.Contains(adminGroup.Trim());
        return isAdmin ? [User, Admin] : [User];
    }

    /// <summary>Ruoli dell'autenticazione di sviluppo (<c>Auth__DevRoles</c>, default <c>user</c>).</summary>
    public static IReadOnlyList<string> ParseDevRoles(string? devRoles)
    {
        var requested = (devRoles ?? User)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(r => r.ToLowerInvariant())
            .ToHashSet();
        var roles = new List<string>();
        if (requested.Contains(User) || requested.Contains(Admin)) roles.Add(User);
        if (requested.Contains(Admin)) roles.Add(Admin);
        return roles;
    }
}

/// <summary>Nomi dei claim salvati nel cookie di sessione.</summary>
public static class CmClaims
{
    public const string Sub = "sub";
    public const string Name = "name";
    public const string Username = "preferred_username";
    public const string Groups = "groups";
    public const string Role = "role";
    public const string Stamp = "cm_stamp";
}

/// <summary>Nomi delle policy di autorizzazione.</summary>
public static class Policies
{
    public const string User = "user";
    public const string Admin = "admin";
}
