using System.Text;
using Microsoft.AspNetCore.DataProtection.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

namespace CineManager.Api.Data;

public class CinemaDbContext(DbContextOptions<CinemaDbContext> options)
    : DbContext(options), IDataProtectionKeyContext
{
    /// <summary>Sequenza degli id dei film non importati da Tellico (arrivi dall'app, id Tellico già occupati).</summary>
    public const string MovieIdSequence = "movies_app_id_seq";
    public const int MovieIdSequenceStart = 1_000_000;

    public DbSet<Movie> Movies => Set<Movie>();
    public DbSet<CollectionField> CollectionFields => Set<CollectionField>();
    public DbSet<UserMovieState> UserMovieStates => Set<UserMovieState>();
    public DbSet<User> Users => Set<User>();
    public DbSet<Device> Devices => Set<Device>();
    public DbSet<PairingCode> PairingCodes => Set<PairingCode>();
    public DbSet<EanLookupCache> EanLookupCache => Set<EanLookupCache>();
    public DbSet<DataProtectionKey> DataProtectionKeys { get; set; } = null!;

    /// <summary>Prossimo valore della sequenza degli id (da 1 000 000).</summary>
    public async Task<int> NextMovieIdAsync(CancellationToken ct = default) =>
        await Database.SqlQueryRaw<int>($"SELECT nextval('{MovieIdSequence}')::int AS \"Value\"")
            .SingleAsync(ct);

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.HasSequence<int>(MovieIdSequence).StartsAt(MovieIdSequenceStart);

        b.Entity<Movie>(e =>
        {
            e.ToTable(t => t.HasCheckConstraint("ck_movies_source", "source IN ('tellico', 'app')"));
            e.HasKey(m => m.Id);
            e.Property(m => m.Id).ValueGeneratedNever();
            e.Property(m => m.Data).HasColumnType("jsonb").IsRequired();
            e.Property(m => m.Source).IsRequired();
            e.HasIndex(m => m.TellicoId).IsUnique();
            e.HasIndex(m => m.Ean).IsUnique();
            e.HasOne<User>().WithMany().HasForeignKey(m => m.CreatedBy).OnDelete(DeleteBehavior.SetNull);
            e.HasOne<Device>().WithMany().HasForeignKey(m => m.CreatedByDevice).OnDelete(DeleteBehavior.SetNull);
        });

        b.Entity<CollectionField>(e =>
        {
            e.HasKey(f => f.Name);
            e.Property(f => f.Title).IsRequired();
            e.Property(f => f.Type).IsRequired();
            e.Property(f => f.Origin).IsRequired();
            e.ToTable(t => t.HasCheckConstraint("ck_collection_fields_origin", "origin IN ('tellico', 'local')"));
        });

        b.Entity<UserMovieState>(e =>
        {
            e.HasKey(s => new { s.UserSub, s.MovieId });
            e.HasIndex(s => s.MovieId);
            e.HasOne<User>().WithMany().HasForeignKey(s => s.UserSub).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Movie>().WithMany().HasForeignKey(s => s.MovieId).OnDelete(DeleteBehavior.Cascade);
            e.ToTable(t =>
            {
                t.HasCheckConstraint("ck_user_movie_state_status", "status IS NULL OR status IN ('seen', 'watchlist')");
                t.HasCheckConstraint("ck_user_movie_state_rating", "rating IS NULL OR rating BETWEEN 1 AND 5");
                t.HasCheckConstraint("ck_user_movie_state_not_empty", "status IS NOT NULL OR rating IS NOT NULL");
            });
        });

        b.Entity<User>(e =>
        {
            e.HasKey(u => u.Sub);
            e.Property(u => u.Username).IsRequired();
            e.Property(u => u.Groups).IsRequired();
        });

        b.Entity<Device>(e =>
        {
            e.HasKey(d => d.Id);
            e.Property(d => d.Id).ValueGeneratedNever();
            e.Property(d => d.Name).IsRequired();
            e.HasIndex(d => d.UserSub);
            e.HasOne<User>().WithMany().HasForeignKey(d => d.UserSub).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<PairingCode>(e =>
        {
            e.HasKey(p => p.CodeHash);
            e.HasIndex(p => p.ExpiresAt);
            e.HasOne<User>().WithMany().HasForeignKey(p => p.UserSub).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<EanLookupCache>(e =>
        {
            e.HasKey(c => c.Ean);
            e.Property(c => c.Provider).IsRequired();
            e.Property(c => c.Response).HasColumnType("jsonb").IsRequired();
        });

        b.Entity<DataProtectionKey>(e => e.ToTable("data_protection_keys"));

        ApplySnakeCase(b);
    }

    /// <summary>Nomi di tabelle, colonne, chiavi e indici in snake_case, come nel documento di design.</summary>
    private static void ApplySnakeCase(ModelBuilder b)
    {
        foreach (var entity in b.Model.GetEntityTypes())
        {
            var table = entity.GetTableName();
            if (table is not null && table != "data_protection_keys")
            {
                table = entity.ClrType.Name switch
                {
                    nameof(EanLookupCache) => "ean_lookup_cache",
                    nameof(UserMovieState) => "user_movie_state",
                    _ => ToSnake(table),
                };
                entity.SetTableName(table);
            }

            foreach (var p in entity.GetProperties())
                p.SetColumnName(ToSnake(p.Name));
            foreach (var k in entity.GetKeys())
                k.SetName(ToSnake(k.GetName() ?? ""));
            foreach (var fk in entity.GetForeignKeys())
                fk.SetConstraintName(ToSnake(fk.GetConstraintName() ?? ""));
            foreach (var ix in entity.GetIndexes())
                ix.SetDatabaseName(ToSnake(ix.GetDatabaseName() ?? ""));
        }
    }

    internal static string ToSnake(string name)
    {
        var sb = new StringBuilder(name.Length + 8);
        for (var i = 0; i < name.Length; i++)
        {
            var c = name[i];
            if (char.IsUpper(c))
            {
                if (i > 0 && name[i - 1] != '_' && (char.IsLower(name[i - 1]) || char.IsDigit(name[i - 1]) ||
                    (i + 1 < name.Length && char.IsLower(name[i + 1]))))
                    sb.Append('_');
                sb.Append(char.ToLowerInvariant(c));
            }
            else sb.Append(c);
        }
        return sb.ToString();
    }
}
