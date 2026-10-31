using System.Collections.Concurrent;

namespace CineManager.Api.Auth;

/// <summary>
/// <c>jti</c> già visti (§4.2, passo 4): in memoria, perché c'è una sola istanza dell'API.
/// Ogni voce scade dopo <see cref="Lifetime"/>, più della finestra massima di validità di un
/// token (60 s + 30 s di tolleranza).
/// </summary>
public sealed class ReplayCache(TimeProvider clock)
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(2);
    private readonly ConcurrentDictionary<string, DateTimeOffset> _seen = new(StringComparer.Ordinal);
    private long _adds;

    /// <summary>Registra il <c>jti</c> del dispositivo; false se era già stato visto e non è scaduto.</summary>
    public bool TryRegister(Guid deviceId, string jti)
    {
        var now = clock.GetUtcNow();
        var key = deviceId.ToString("N") + ":" + jti;
        if (Interlocked.Increment(ref _adds) % 256 == 0) Purge(now);
        if (_seen.TryAdd(key, now + Lifetime)) return true;
        // Voce scaduta ma non ancora ripulita: si può riusare (il token sarebbe comunque scaduto).
        if (_seen.TryGetValue(key, out var exp) && exp <= now &&
            _seen.TryUpdate(key, now + Lifetime, exp))
            return true;
        return false;
    }

    private void Purge(DateTimeOffset now)
    {
        foreach (var (k, exp) in _seen)
            if (exp <= now) _seen.TryRemove(new KeyValuePair<string, DateTimeOffset>(k, exp));
    }
}
