namespace CineManager.Api.Data;

/// <summary>Film della collezione (§5, tabella <c>movies</c>).</summary>
public class Movie
{
    /// <summary>Per gli importati = id Tellico (se libero); per gli altri dalla sequenza da 1 000 000.</summary>
    public int Id { get; set; }

    /// <summary>Id dell'entry nel <c>.tc</c>; null per gli arrivi non ancora collegati.</summary>
    public int? TellicoId { get; set; }

    /// <summary>Codice a barre normalizzato (solo cifre, UPC-A con zero davanti).</summary>
    public string? Ean { get; set; }

    /// <summary>Oggetto <c>Movie</c> del parser del sito, senza <c>id</c> (jsonb).</summary>
    public string Data { get; set; } = "{}";

    /// <summary><c>tellico</c> | <c>app</c>.</summary>
    public string Source { get; set; } = MovieSources.Tellico;

    public int? TmdbId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public string? CreatedBy { get; set; }
    public Guid? CreatedByDevice { get; set; }
    public DateTimeOffset? ExportedAt { get; set; }
}

public static class MovieSources
{
    public const string Tellico = "tellico";
    public const string App = "app";
}

/// <summary>Definizione di un campo della collezione (§5, <c>collection_fields</c>).</summary>
public class CollectionField
{
    public string Name { get; set; } = "";
    public string Title { get; set; } = "";
    public string Type { get; set; } = FieldTypes.Line;
    public bool Multiple { get; set; }
    public List<string>? Allowed { get; set; }
    /// <summary><c>tellico</c> | <c>local</c>.</summary>
    public string Origin { get; set; } = FieldOrigins.Tellico;
    public bool Groupable { get; set; }
    public int GroupMinSize { get; set; }
    public bool InForm { get; set; }
    public int Ordinal { get; set; }
}

public static class FieldOrigins
{
    public const string Tellico = "tellico";
    public const string Local = "local";
}

public static class FieldTypes
{
    public const string Line = "line";
    public const string Para = "para";
    public const string Number = "number";
    public const string Bool = "bool";
    public const string Date = "date";
    public const string Choice = "choice";
    public const string Url = "url";
    public const string Rating = "rating";
    public const string Table = "table";
    public const string Image = "image";
    public const string Dependent = "dependent";
}

/// <summary>Visto/watchlist e voto di un utente per un film. La riga sparisce quando entrambi sono null.</summary>
public class UserMovieState
{
    public string UserSub { get; set; } = "";
    public int MovieId { get; set; }
    /// <summary><c>seen</c> | <c>watchlist</c> | null.</summary>
    public string? Status { get; set; }
    /// <summary>1–5 | null.</summary>
    public short? Rating { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>Copia dei dati ricevuti dal provider OIDC all'ultimo login.</summary>
public class User
{
    public string Sub { get; set; } = "";
    public string Username { get; set; } = "";
    public string? DisplayName { get; set; }
    public List<string> Groups { get; set; } = [];
    public DateTimeOffset LastLoginAt { get; set; }
    /// <summary>Copiato nel cookie a ogni login; rigenerarlo invalida le sessioni attive.</summary>
    public Guid SecurityStamp { get; set; }
}

/// <summary>Telefono abbinato (fase 3).</summary>
public class Device
{
    public Guid Id { get; set; }
    public string UserSub { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>Chiave pubblica EC P-256, SPKI DER.</summary>
    public byte[] PublicKey { get; set; } = [];
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? LastSeenAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
}

/// <summary>Codice di abbinamento monouso: nel DB solo lo SHA-256 (fase 3).</summary>
public class PairingCode
{
    public byte[] CodeHash { get; set; } = [];
    public string UserSub { get; set; } = "";
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? UsedAt { get; set; }
}

/// <summary>Cache delle risposte dei provider di codici a barre (fase 3).</summary>
public class EanLookupCache
{
    public string Ean { get; set; } = "";
    public string Provider { get; set; } = "";
    /// <summary>Risposta del provider (jsonb).</summary>
    public string Response { get; set; } = "{}";
    public DateTimeOffset FetchedAt { get; set; }
}
