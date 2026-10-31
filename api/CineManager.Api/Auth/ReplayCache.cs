using System.Collections.Concurrent;

namespace CineManager.Api.Auth;

/// <summary>
/// <c>jti</c> già visti (§4.2, passo 4): in memoria, perché c'è una sola istanza dell'API.
/// Ogni voce vive finché il token potrebbe ancora essere accettato: fino a <c>exp</c> + tolleranza
/// sull'orologio (30 s) + <see cref="Margin"/>. Una durata fissa pari alla finestra massima
/// (60 s + 30 s + 30 s) lasciava un replay possibile al confine, per l'arrotondamento ai secondi.
/// </summary>
public sealed class ReplayCache(TimeProvider clock)
{
    /// <summary>Margine oltre l'ultimo istante di validità del token.</summary>
    public static readonly TimeSpan Margin = TimeSpan.FromSeconds(10);
    private readonly ConcurrentDictionary<string, DateTimeOffset> _seen = new(StringComparer.Ordinal);
    private long _adds;

    /// <summary>
    /// Registra il <c>jti</c> del dispositivo per il token con scadenza <paramref name="tokenExp"/>
    /// (secondi Unix); false se era già stato visto e la voce non è scaduta.
    /// </summary>
    public bool TryRegister(Guid deviceId, string jti, long tokenExp)
    {
        var now = clock.GetUtcNow();
        // Accettato finché floor(now) ≤ exp + skew, cioè fino a exp + skew + 1 s escluso.
        var until = DateTimeOffset.FromUnixTimeSeconds(tokenExp + DeviceAuthHandler.ClockSkewSeconds + 1) + Margin;
        if (until <= now) until = now + Margin;
        var key = deviceId.ToString("N") + ":" + jti;
        if (Interlocked.Increment(ref _adds) % 256 == 0) Purge(now);
        if (_seen.TryAdd(key, until)) return true;
        // Voce scaduta ma non ancora ripulita: si può riusare (il token sarebbe comunque scaduto).
        if (_seen.TryGetValue(key, out var exp) && exp <= now && _seen.TryUpdate(key, until, exp))
            return true;
        return false;
    }

    private void Purge(DateTimeOffset now)
    {
        foreach (var (k, exp) in _seen)
            if (exp <= now) _seen.TryRemove(new KeyValuePair<string, DateTimeOffset>(k, exp));
    }
}
