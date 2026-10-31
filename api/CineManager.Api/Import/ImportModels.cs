using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace CineManager.Api.Import;

/// <summary>Definizione di un campo come la invia il parser del sito.</summary>
public sealed class TellicoField
{
    public string Name { get; set; } = "";
    public string? Title { get; set; }
    /// <summary>Codice numerico Tellico (accettato anche come numero).</summary>
    [JsonConverter(typeof(StringOrNumberConverter))]
    public string? Type { get; set; }
    public int Flags { get; set; }
    /// <summary>Se assente si ricava dal bit 0x01 di <see cref="Flags"/>.</summary>
    public bool? Multiple { get; set; }
    /// <summary>Se assente si ricava dal bit 0x02 di <see cref="Flags"/>.</summary>
    public bool? Groupable { get; set; }
    public List<string>? Allowed { get; set; }
}

public sealed class TellicoImportRequest
{
    public List<TellicoField>? Fields { get; set; }
    public List<JsonObject>? Movies { get; set; }
}

public sealed record MissingMovie(int Id, string? Title);

public sealed record TellicoImportResult(
    int Inserted, int Updated, int Linked, int Unchanged, IReadOnlyList<MissingMovie> Missing, int FieldsUpdated);

public sealed class ImagesImportRequest
{
    public Dictionary<string, string>? Images { get; set; }
}

public sealed record ImagesImportResult(int Written, int Skipped);

/// <summary>Errore di validazione del contenuto dell'import (→ 400).</summary>
public sealed class ImportValidationException(string message) : Exception(message);

internal sealed class StringOrNumberConverter : JsonConverter<string?>
{
    public override string? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.TokenType switch
        {
            JsonTokenType.String => reader.GetString(),
            JsonTokenType.Number => reader.TryGetInt64(out var l) ? l.ToString() : reader.GetDouble().ToString(System.Globalization.CultureInfo.InvariantCulture),
            JsonTokenType.Null => null,
            _ => throw new JsonException("Valore non valido per 'type'."),
        };

    public override void Write(Utf8JsonWriter writer, string? value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value);
}
