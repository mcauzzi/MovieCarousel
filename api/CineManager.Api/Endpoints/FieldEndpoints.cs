using System.Text.Json;
using System.Text.RegularExpressions;
using CineManager.Api.Auth;
using CineManager.Api.Data;
using CineManager.Api.Infrastructure;
using CineManager.Api.Movies;
using Microsoft.EntityFrameworkCore;

namespace CineManager.Api.Endpoints;

/// <summary>Gestione dei campi della collezione (§5.1): lettura per tutti, scritture per l'admin.</summary>
public static partial class FieldEndpoints
{
    [GeneratedRegex("^[a-z][a-z0-9-]{0,40}$")]
    private static partial Regex NameRegex();

    /// <summary>Nomi che un campo locale non può avere (colonne o campi impostati dal server).</summary>
    private static readonly HashSet<string> Reserved = new(StringComparer.Ordinal) { "id", "cdate", "mdate", FieldCatalog.CoverField };

    /// <summary>Tipi creabili dal sito: niente <c>image</c> (nessun caricamento) né <c>dependent</c> (calcolati da Tellico).</summary>
    private static readonly HashSet<string> CreatableTypes = new(StringComparer.Ordinal)
    {
        FieldTypes.Line, FieldTypes.Para, FieldTypes.Number, FieldTypes.Bool, FieldTypes.Date, FieldTypes.Choice,
        FieldTypes.Url, FieldTypes.Rating, FieldTypes.Table,
    };

    private static readonly HashSet<string> CreateKeys = ["name", "title", "type", "multiple", "allowed", "groupable", "groupMinSize", "inForm", "ordinal"];
    private static readonly HashSet<string> PatchKeys = ["title", "groupable", "groupMinSize", "inForm", "ordinal", "allowed"];

    public const int MaxTitle = 100;
    public const int MaxAllowed = 200;

    public static CollectionFieldDto ToDto(CollectionField f) => new(f.Name, f.Title, f.Type, f.Multiple, f.Allowed, f.Origin,
        f.Groupable, f.GroupMinSize, f.InForm, f.Ordinal);

    public static void MapFieldEndpoints(this IEndpointRouteBuilder app)
    {
        // Catalogo completo: prima di ogni import anche i campi standard di Tellico (FieldCatalog).
        app.MapGet("/api/fields", async (CinemaDbContext db, CancellationToken ct) =>
            (await FieldCatalog.LoadAsync(db, ct)).Select(ToDto).ToList())
            .RequireAuthorization(Policies.User);

        var admin = app.MapGroup("/api/fields").RequireAuthorization(Policies.Admin);

        admin.MapPost("", async (JsonElement body, CinemaDbContext db, CancellationToken ct) =>
        {
            if (body.ValueKind != JsonValueKind.Object) return Bad("Il corpo deve essere un oggetto JSON.");
            if (UnknownKey(body, CreateKeys) is { } unknown) return Bad($"Proprietà sconosciuta: '{unknown}'.");

            var name = Str(body, "name");
            if (name is null || !NameRegex().IsMatch(name))
                return Bad("'name': minuscole, cifre e trattini, inizia con una lettera, al massimo 41 caratteri.");
            if (Reserved.Contains(name)) return Bad($"'{name}' è un nome riservato.");
            var type = Str(body, "type");
            if (type is null || !CreatableTypes.Contains(type))
                return Bad("'type' deve essere uno tra: " + string.Join(", ", CreatableTypes) + ".");
            var field = new CollectionField
            {
                Name = name, Type = type, Origin = FieldOrigins.Local, GroupMinSize = 3, InForm = true,
            };
            if (Apply(body, field, creating: true) is { } error) return Bad(error);
            if (string.IsNullOrEmpty(field.Title)) return Bad("'title' obbligatorio.");

            if (await db.CollectionFields.AnyAsync(f => f.Name == name, ct))
                return Results.Problem(statusCode: StatusCodes.Status409Conflict, title: "Campo già esistente",
                    detail: $"Esiste già un campo '{name}'.");
            if (!body.TryGetProperty("ordinal", out _))
                // In coda a tutti i campi in uso (anche quelli standard se non c'è ancora un import).
                field.Ordinal = (await FieldCatalog.LoadAsync(db, ct)).Select(f => f.Ordinal).DefaultIfEmpty(-1).Max() + 1;
            db.CollectionFields.Add(field);
            await db.SaveChangesAsync(ct);
            return Results.Created($"/api/fields/{name}", ToDto(field));
        });

        admin.MapPatch("/{name}", async (string name, JsonElement body, CinemaDbContext db, CancellationToken ct) =>
        {
            if (body.ValueKind != JsonValueKind.Object) return Bad("Il corpo deve essere un oggetto JSON.");
            if (UnknownKey(body, PatchKeys) is { } unknown) return Bad($"Proprietà non modificabile: '{unknown}'.");
            var field = await db.CollectionFields.FirstOrDefaultAsync(f => f.Name == name, ct);
            if (field is null && FieldCatalog.Defaults.Any(f => f.Name == name) &&
                !await db.CollectionFields.AnyAsync(f => f.Origin == FieldOrigins.Tellico, ct))
            {
                // Campo standard prima del primo import: si salvano tutti gli standard mancanti (non
                // solo questo, altrimenti il catalogo smetterebbe di completare gli altri). Il primo
                // import li aggiorna o li rimuove come qualsiasi campo di Tellico.
                var present = await db.CollectionFields.Select(f => f.Name).ToListAsync(ct);
                foreach (var d in FieldCatalog.Defaults.Where(d => !present.Contains(d.Name)))
                {
                    var row = Copy(d);
                    db.CollectionFields.Add(row);
                    if (row.Name == name) field = row;
                }
            }
            if (field is null) return Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "Campo inesistente");
            if (Apply(body, field, creating: false) is { } error) return Bad(error);
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(field));
        });

        // Solo campi locali; con purge=true i valori spariscono anche da movies.data.
        admin.MapDelete("/{name}", async (string name, bool? purge, CinemaDbContext db, CancellationToken ct) =>
        {
            var field = await db.CollectionFields.FirstOrDefaultAsync(f => f.Name == name, ct);
            var standard = field is null && (await FieldCatalog.LoadAsync(db, ct)).Any(f => f.Name == name);
            if (field is null && !standard)
                return Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "Campo inesistente");
            if (standard || field!.Origin != FieldOrigins.Local)
                return Results.Problem(statusCode: StatusCodes.Status409Conflict, title: "Campo di Tellico",
                    detail: "I campi di Tellico si eliminano in Tellico e spariscono al successivo import.");
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            db.CollectionFields.Remove(field!);
            await db.SaveChangesAsync(ct);
            if (purge == true)
                await db.Database.ExecuteSqlInterpolatedAsync($"UPDATE movies SET data = data - {name} WHERE data ? {name}", ct);
            await tx.CommitAsync(ct);
            return Results.NoContent();
        });
    }

    /// <summary>Applica title/multiple/allowed/groupable/groupMinSize/inForm/ordinal presenti nel corpo; errore o null.</summary>
    private static string? Apply(JsonElement body, CollectionField f, bool creating)
    {
        foreach (var p in body.EnumerateObject())
        {
            var v = p.Value;
            switch (p.Name)
            {
                case "title":
                    if (v.ValueKind != JsonValueKind.String || v.GetString()!.Trim() is not { Length: > 0 and <= MaxTitle } t || t.Any(char.IsControl))
                        return $"'title': da 1 a {MaxTitle} caratteri.";
                    f.Title = t;
                    break;
                case "multiple" when creating:
                    if (v.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return "'multiple' deve essere un booleano.";
                    f.Multiple = v.GetBoolean();
                    break;
                case "groupable":
                    if (v.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return "'groupable' deve essere un booleano.";
                    f.Groupable = v.GetBoolean();
                    break;
                case "inForm":
                    if (v.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return "'inForm' deve essere un booleano.";
                    f.InForm = v.GetBoolean();
                    break;
                case "groupMinSize":
                    if (v.ValueKind != JsonValueKind.Number || !v.TryGetInt32(out var g) || g is < 1 or > 1000)
                        return "'groupMinSize' deve essere un intero da 1 a 1000.";
                    f.GroupMinSize = g;
                    break;
                case "ordinal":
                    if (v.ValueKind != JsonValueKind.Number || !v.TryGetInt32(out var o) || o is < 0 or > 100_000)
                        return "'ordinal' deve essere un intero da 0 a 100000.";
                    f.Ordinal = o;
                    break;
                case "allowed":
                    if (v.ValueKind == JsonValueKind.Null) { f.Allowed = null; break; }
                    if (v.ValueKind != JsonValueKind.Array) return "'allowed' deve essere un elenco di testi o null.";
                    var list = new List<string>();
                    foreach (var item in v.EnumerateArray())
                    {
                        if (item.ValueKind != JsonValueKind.String || item.GetString()!.Trim() is not { Length: > 0 and <= MovieValidator.MaxLine } s ||
                            s.Any(char.IsControl))
                            return "'allowed': testi non vuoti, senza caratteri di controllo.";
                        if (!list.Contains(s)) list.Add(s);
                    }
                    if (list.Count > MaxAllowed) return $"'allowed': al massimo {MaxAllowed} valori.";
                    f.Allowed = list.Count == 0 ? null : list;
                    break;
            }
        }
        if (body.TryGetProperty("allowed", out _) && f.Allowed is not null && f.Type != FieldTypes.Choice)
            return "'allowed' vale solo per i campi di tipo choice.";
        return null;
    }

    private static CollectionField Copy(CollectionField f) => new()
    {
        Name = f.Name, Title = f.Title, Type = f.Type, Multiple = f.Multiple, Allowed = f.Allowed?.ToList(),
        Origin = f.Origin, Groupable = f.Groupable, GroupMinSize = f.GroupMinSize, InForm = f.InForm, Ordinal = f.Ordinal,
    };

    private static string? UnknownKey(JsonElement body, HashSet<string> allowed) =>
        body.EnumerateObject().Select(p => p.Name).FirstOrDefault(n => !allowed.Contains(n));

    private static string? Str(JsonElement body, string name) =>
        body.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static IResult Bad(string detail) => ApiResults.Bad(detail, "Campo non valido");
}
