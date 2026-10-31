using CineManager.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Npgsql;

namespace CineManager.Api.Auth;

/// <summary>Copia in <c>users</c> i dati ricevuti al login e verifica il timbro di sicurezza.</summary>
public sealed class UserSync(CinemaDbContext db, IMemoryCache cache, TimeProvider clock)
{
    /// <summary>
    /// Upsert di sub, username, nome, gruppi e ultimo login. Il timbro di sicurezza resta quello
    /// esistente (un nuovo utente ne riceve uno nuovo) e viene restituito per il cookie.
    /// </summary>
    public async Task<Guid> UpsertAsync(string sub, string? username, string? displayName,
        IReadOnlyCollection<string> groups, CancellationToken ct = default)
    {
        for (var attempt = 0; ; attempt++)
        {
            var user = await db.Users.FirstOrDefaultAsync(u => u.Sub == sub, ct);
            if (user is null)
            {
                user = new User { Sub = sub, SecurityStamp = Guid.NewGuid() };
                db.Users.Add(user);
            }
            user.Username = string.IsNullOrWhiteSpace(username) ? sub : username;
            user.DisplayName = string.IsNullOrWhiteSpace(displayName) ? null : displayName;
            user.Groups = [.. groups];
            user.LastLoginAt = clock.GetUtcNow();
            try
            {
                await db.SaveChangesAsync(ct);
                cache.Set(StampKey(sub), user.SecurityStamp, TimeSpan.FromMinutes(1));
                return user.SecurityStamp;
            }
            catch (DbUpdateException ex) when (attempt == 0 && ex.InnerException is PostgresException
                                                   { SqlState: PostgresErrorCodes.UniqueViolation })
            {
                // Due login simultanei dello stesso utente: si riprova come aggiornamento.
                db.ChangeTracker.Clear();
            }
        }
    }

    /// <summary>Timbro attuale dell'utente (null se non esiste), con cache di <paramref name="cacheFor"/>.</summary>
    public async Task<Guid?> GetStampAsync(string sub, TimeSpan cacheFor, CancellationToken ct = default)
    {
        if (cacheFor > TimeSpan.Zero && cache.TryGetValue(StampKey(sub), out Guid cached)) return cached;
        var stamp = await db.Users.Where(u => u.Sub == sub).Select(u => (Guid?)u.SecurityStamp)
            .FirstOrDefaultAsync(ct);
        if (stamp is { } s && cacheFor > TimeSpan.Zero) cache.Set(StampKey(sub), s, cacheFor);
        return stamp;
    }

    /// <summary>
    /// Nuovo timbro di sicurezza: le sessioni del sito già emesse non sono più valide (§4.1).
    /// False se l'utente non esiste.
    /// </summary>
    public async Task<bool> RegenerateStampAsync(string sub, CancellationToken ct = default)
    {
        var stamp = Guid.NewGuid();
        var n = await db.Users.Where(u => u.Sub == sub)
            .ExecuteUpdateAsync(s => s.SetProperty(u => u.SecurityStamp, stamp), ct);
        cache.Remove(StampKey(sub));
        return n > 0;
    }

    private static string StampKey(string sub) => "cm:stamp:" + sub;
}
