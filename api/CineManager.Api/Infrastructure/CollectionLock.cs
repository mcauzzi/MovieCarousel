using CineManager.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace CineManager.Api.Infrastructure;

/// <summary>
/// Advisory lock di transazione sulla collezione: esclusivo per l'import da Tellico e l'export
/// CSV, condiviso per le scritture dei singoli film (arrivi, PATCH, DELETE). Così un import non
/// legge i film mentre un arrivo li cambia (modifiche perse, EAN in conflitto, 500) e il cutoff
/// dell'export separa nettamente gli arrivi inclusi da quelli successivi. Va preso dentro una
/// transazione: si rilascia con il commit o il rollback.
/// </summary>
public static class CollectionLock
{
    public const long Key = 7243100;

    public static Task ExclusiveAsync(CinemaDbContext db, CancellationToken ct) =>
        db.Database.ExecuteSqlRawAsync($"SELECT pg_advisory_xact_lock({Key})", ct);

    public static Task SharedAsync(CinemaDbContext db, CancellationToken ct) =>
        db.Database.ExecuteSqlRawAsync($"SELECT pg_advisory_xact_lock_shared({Key})", ct);
}
