namespace CineManager.Api.Auth;

public static class LocalUrl
{
    /// <summary>
    /// <c>returnUrl</c> accettato solo se è un percorso locale (equivalente di <c>Url.IsLocalUrl</c>:
    /// inizia con <c>/</c>, non con <c>//</c> o <c>/\</c>, niente caratteri di controllo);
    /// altrimenti <c>/</c>. Evita l'open redirect (§4.1).
    /// </summary>
    public static string Sanitize(string? returnUrl) => IsLocal(returnUrl) ? returnUrl! : "/";

    public static bool IsLocal(string? url)
    {
        if (string.IsNullOrEmpty(url) || url[0] != '/') return false;
        if (url.Length > 1 && (url[1] == '/' || url[1] == '\\')) return false;
        foreach (var c in url)
            if (char.IsControl(c)) return false;
        return true;
    }
}
