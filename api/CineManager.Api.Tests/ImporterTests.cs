using System.Text.Json.Nodes;
using CineManager.Api.Data;
using CineManager.Api.Import;
using CineManager.Api.Tests.Support;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace CineManager.Api.Tests;

/// <summary>Abbinamento e aggiornamento dell'import da Tellico (§8).</summary>
public class ImporterTests(ApiFixture fx) : IClassFixture<ApiFixture>, IAsyncLifetime
{
    private ApiFactory F => fx.Factory;

    public Task InitializeAsync() => TestDb.BaseConnection is null ? Task.CompletedTask : F.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    private static readonly List<TellicoField> BaseFields =
    [
        new() { Name = "title", Title = "Titolo", Type = "1", Flags = 0 },
        new() { Name = "year", Title = "Anno", Type = "6", Flags = 2, Groupable = true },
        new() { Name = "genre", Title = "Genere", Type = "1", Flags = 7, Multiple = true, Groupable = true },
        new() { Name = "cover", Title = "Copertina", Type = "10", Flags = 0 },
        new() { Name = "ean", Title = "EAN", Type = "1", Flags = 0 },
        new() { Name = "cdate", Title = "Creato", Type = "12", Flags = 0x30 },
    ];

    private static JsonObject Entry(int id, string title, int year, string? cdate = null, string? ean = null, string? cover = null)
    {
        var o = new JsonObject { ["id"] = id, ["title"] = title, ["year"] = year, ["genre"] = new JsonArray("Drammatico") };
        if (cdate is not null) o["cdate"] = cdate;
        if (ean is not null) o["ean"] = ean;
        if (cover is not null) o["cover"] = cover;
        return o;
    }

    private async Task<TellicoImportResult> Import(params JsonObject[] movies) => await Import(BaseFields, movies);

    private async Task<TellicoImportResult> Import(List<TellicoField> fields, params JsonObject[] movies)
    {
        using var scope = F.Services.CreateScope();
        var importer = scope.ServiceProvider.GetRequiredService<TellicoImporter>();
        return await importer.ImportAsync(new TellicoImportRequest { Fields = fields, Movies = [.. movies] }, default);
    }

    private Task AddMovie(int id, JsonObject data, string source = MovieSources.App, int? tellicoId = null, string? ean = null) =>
        F.WithDbAsync(async db =>
        {
            db.Movies.Add(new Movie
            {
                Id = id, Data = data.ToJsonString(), Source = source, TellicoId = tellicoId, Ean = ean,
                CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow,
            });
            await db.SaveChangesAsync();
        });

    private Task<List<Movie>> Movies() => F.WithDbAsync(db => db.Movies.AsNoTracking().OrderBy(m => m.Id).ToListAsync());

    private static JsonObject DataOf(Movie m) => (JsonObject)JsonNode.Parse(m.Data)!;

    [DbFact]
    public async Task Nuovi_film_usano_id_Tellico_e_poi_restano_invariati()
    {
        var r = await Import(Entry(1, "Il padrino", 1972, "2020-01-01"), Entry(2, "Alien", 1979));
        Assert.Equal((2, 0, 0, 0), (r.Inserted, r.Updated, r.Linked, r.Unchanged));
        var ms = await Movies();
        Assert.Equal([1, 2], ms.Select(m => m.Id));
        Assert.All(ms, m => Assert.Equal(m.Id, m.TellicoId));
        Assert.All(ms, m => Assert.Equal(MovieSources.Tellico, m.Source));
        Assert.False(DataOf(ms[0]).ContainsKey("id")); // l'id è la colonna, non un valore di data

        var again = await Import(Entry(1, "Il padrino", 1972, "2020-01-01"), Entry(2, "Alien", 1979));
        Assert.Equal((0, 0, 0, 2), (again.Inserted, again.Updated, again.Linked, again.Unchanged));

        var changed = await Import(Entry(1, "Il padrino", 1972, "2020-01-01"), Entry(2, "Alien - Director's cut", 1979));
        Assert.Equal((0, 1, 0, 1), (changed.Inserted, changed.Updated, changed.Linked, changed.Unchanged));
    }

    [DbFact]
    public async Task Abbina_per_EAN_un_arrivo_dall_app()
    {
        await AddMovie(1_000_000, new JsonObject { ["title"] = "Il padrino", ["year"] = 1972, ["cover"] = "cm-1000000.jpg" },
            ean: "8012345678901");
        var r = await Import(Entry(57, "Il Padrino (titolo corretto)", 1972, ean: "801-2345678901"));
        Assert.Equal((0, 0, 1, 0), (r.Inserted, r.Updated, r.Linked, r.Unchanged));
        var m = Assert.Single(await Movies());
        Assert.Equal(1_000_000, m.Id); // l'id non cambia: visto/voto restano agganciati
        Assert.Equal(57, m.TellicoId);
        Assert.Equal(MovieSources.Tellico, m.Source);
        Assert.Equal("Il Padrino (titolo corretto)", DataOf(m)["title"]!.GetValue<string>());
        Assert.Equal("cm-1000000.jpg", DataOf(m)["cover"]!.GetValue<string>()); // copertina preservata
    }

    [DbFact]
    public async Task Abbina_per_titolo_e_anno_solo_arrivi_non_collegati()
    {
        await AddMovie(1_000_000, new JsonObject { ["title"] = "L'odio", ["year"] = 1995 });
        // Un film Tellico con lo stesso titolo non va mai abbinato per titolo.
        await AddMovie(10, new JsonObject { ["title"] = "Amélie", ["year"] = 2001 }, MovieSources.Tellico, tellicoId: 10);

        var r = await Import(Entry(10, "Amélie", 2001), Entry(20, "L ODIO", 1995), Entry(21, "Amelie", 2001));
        Assert.Equal(1, r.Linked);
        Assert.Equal(1, r.Inserted); // "Amelie" (21) è nuovo, non abbinato al film Tellico 10
        var ms = await Movies();
        Assert.Equal(20, ms.Single(m => m.Id == 1_000_000).TellicoId);
        Assert.Equal(21, ms.Single(m => m.Id == 21).TellicoId);
    }

    [DbFact]
    public async Task Titolo_uguale_anno_diverso_non_abbina()
    {
        await AddMovie(1_000_000, new JsonObject { ["title"] = "Dune", ["year"] = 1984 });
        var r = await Import(Entry(5, "Dune", 2021));
        Assert.Equal(1, r.Inserted);
        Assert.Null((await Movies()).Single(m => m.Id == 1_000_000).TellicoId);
    }

    [DbFact]
    public async Task Id_riusato_riconosciuto_da_cdate()
    {
        await Import(Entry(7, "Vecchio film", 1960, "2019-05-05"));
        var r = await Import(Entry(7, "Film nuovo", 2023, "2024-02-02"));

        Assert.Equal(1, r.Inserted);
        var missing = Assert.Single(r.Missing);
        Assert.Equal((7, "Vecchio film"), (missing.Id, missing.Title));
        var ms = await Movies();
        var old = ms.Single(m => m.Id == 7);
        Assert.Null(old.TellicoId);
        var nuovo = ms.Single(m => m.TellicoId == 7);
        Assert.True(nuovo.Id >= CinemaDbContext.MovieIdSequenceStart); // id 7 occupato → sequenza
        Assert.Equal("Film nuovo", DataOf(nuovo)["title"]!.GetValue<string>());
    }

    [DbFact]
    public async Task Id_con_cdate_mancante_da_una_parte_viene_accettato()
    {
        await Import(Entry(7, "Titolo", 1960));
        var r = await Import(Entry(7, "Titolo corretto", 1960, "2024-02-02"));
        Assert.Equal((0, 1, 0), (r.Inserted, r.Updated, r.Missing.Count));
    }

    [DbFact]
    public async Task Conflitto_tellico_id_azzera_il_collegamento_dell_altro_film()
    {
        // Film 30 collegato all'entry 30; l'arrivo con EAN viene ora catalogato in Tellico proprio come entry 30.
        await Import(Entry(30, "Doppione", 2000));
        await AddMovie(1_000_000, new JsonObject { ["title"] = "Arrivo", ["year"] = 2010 }, ean: "8000000000001");

        var r = await Import(Entry(30, "Arrivo", 2010, ean: "8000000000001"));
        Assert.Equal(1, r.Linked);
        var ms = await Movies();
        Assert.Equal(30, ms.Single(m => m.Id == 1_000_000).TellicoId);
        Assert.Null(ms.Single(m => m.Id == 30).TellicoId);
        Assert.Equal(30, Assert.Single(r.Missing).Id);
    }

    [DbFact]
    public async Task Missing_elenca_i_film_assenti_senza_cancellarli()
    {
        await Import(Entry(1, "Uno", 2001), Entry(2, "Due", 2002));
        await AddMovie(1_000_000, new JsonObject { ["title"] = "Arrivo", ["year"] = 2020 });
        var r = await Import(Entry(1, "Uno", 2001));
        var miss = Assert.Single(r.Missing); // l'arrivo dall'app non è "mancante"
        Assert.Equal((2, "Due"), (miss.Id, miss.Title));
        Assert.Equal(3, (await Movies()).Count);
        Assert.Equal(2, (await Movies()).Single(m => m.Id == 2).TellicoId);
    }

    [DbFact]
    public async Task Copertina_e_campi_local_preservati()
    {
        await F.WithDbAsync(async db =>
        {
            db.CollectionFields.Add(new CollectionField { Name = "scaffale", Title = "Scaffale", Origin = FieldOrigins.Local, Ordinal = 50 });
            db.CollectionFields.Add(new CollectionField { Name = "prestato", Title = "Prestato", Origin = FieldOrigins.Local, Ordinal = 51 });
            await db.SaveChangesAsync();
        });
        await AddMovie(1, new JsonObject
        {
            ["title"] = "Uno", ["year"] = 2001, ["cover"] = "vecchia.jpg", ["scaffale"] = "A3", ["prestato"] = "Luca",
        }, MovieSources.Tellico, tellicoId: 1);

        // "prestato" ora esiste anche in Tellico (vince Tellico), "scaffale" no (resta).
        var fields = BaseFields.Append(new TellicoField { Name = "prestato", Title = "Prestato a", Type = "1" }).ToList();
        var r = await Import(fields, Entry(1, "Uno", 2001));
        Assert.Equal(1, r.Updated);
        var d = DataOf(Assert.Single(await Movies()));
        Assert.Equal("vecchia.jpg", d["cover"]!.GetValue<string>());
        Assert.Equal("A3", d["scaffale"]!.GetValue<string>());
        Assert.False(d.ContainsKey("prestato"));

        var defs = await F.WithDbAsync(db => db.CollectionFields.AsNoTracking().ToDictionaryAsync(f => f.Name));
        Assert.Equal(FieldOrigins.Tellico, defs["prestato"].Origin);
        Assert.Equal("Prestato a", defs["prestato"].Title);
        Assert.Equal(FieldOrigins.Local, defs["scaffale"].Origin);

        // Copertina nuova dal .tc: vince Tellico.
        await Import(fields, Entry(1, "Uno", 2001, cover: "nuova.jpg"));
        Assert.Equal("nuova.jpg", DataOf(Assert.Single(await Movies()))["cover"]!.GetValue<string>());
    }

    [DbFact]
    public async Task EAN_aggiornato_solo_se_presente()
    {
        await Import(Entry(1, "Uno", 2001, ean: "8000000000001"));
        await Import(Entry(1, "Uno", 2001));
        Assert.Equal("8000000000001", Assert.Single(await Movies()).Ean);
        await Import(Entry(1, "Uno", 2001, ean: "8000000000002"));
        Assert.Equal("8000000000002", Assert.Single(await Movies()).Ean);
    }

    [DbFact]
    public async Task Definizioni_dei_campi_e_preferenze_non_sovrascritte()
    {
        var fields = new List<TellicoField>
        {
            new() { Name = "id", Title = "ID", Type = "6", Flags = 0x18 },
            new() { Name = "title", Title = "Titolo", Type = "1" },
            new() { Name = "genre", Title = "Genere", Type = "1", Flags = 0x07 },               // multiplo/raggruppabile dai flag
            new() { Name = "nationality", Title = "Nazionalità", Type = "1", Flags = 3, Multiple = true, Groupable = true },
            new() { Name = "medium", Title = "Supporto", Type = 3.ToString(), Allowed = ["DVD", "Blu-ray"] },
            new() { Name = "eta", Title = "Età", Type = "6", Flags = 0x20 },
            new() { Name = "cover", Title = "Copertina", Type = "10" },
            new() { Name = "vecchio", Title = "Vecchio", Type = "1" },
        };
        var r = await Import(fields);
        Assert.Equal(7, r.FieldsUpdated); // "id" escluso

        var defs = await F.WithDbAsync(db => db.CollectionFields.AsNoTracking().ToDictionaryAsync(f => f.Name));
        Assert.False(defs.ContainsKey("id"));
        Assert.True(defs["genre"].Multiple && defs["genre"].Groupable);
        Assert.Equal(3, defs["genre"].GroupMinSize);
        Assert.Equal(4, defs["nationality"].GroupMinSize);
        Assert.Equal(FieldTypes.Choice, defs["medium"].Type);
        Assert.Equal(["DVD", "Blu-ray"], defs["medium"].Allowed!);
        Assert.Equal(FieldTypes.Dependent, defs["eta"].Type);
        Assert.False(defs["eta"].InForm);
        Assert.False(defs["cover"].InForm);
        Assert.True(defs["title"].InForm);
        Assert.True(defs["title"].Ordinal < defs["genre"].Ordinal);

        // Preferenze impostate dal sito.
        await F.WithDbAsync(async db =>
        {
            var g = await db.CollectionFields.FindAsync("genre");
            g!.Groupable = false; g.GroupMinSize = 9; g.InForm = false; g.Ordinal = 99;
            await db.SaveChangesAsync();
        });

        fields[2] = new TellicoField { Name = "genre", Title = "Generi", Type = "1", Flags = 0x07 };
        fields.RemoveAt(fields.Count - 1); // "vecchio" sparisce da Tellico
        var r2 = await Import(fields);
        Assert.Equal(2, r2.FieldsUpdated);
        defs = await F.WithDbAsync(db => db.CollectionFields.AsNoTracking().ToDictionaryAsync(f => f.Name));
        Assert.Equal("Generi", defs["genre"].Title);
        Assert.Equal((false, 9, false, 99), (defs["genre"].Groupable, defs["genre"].GroupMinSize, defs["genre"].InForm, defs["genre"].Ordinal));
        Assert.False(defs.ContainsKey("vecchio"));

        Assert.Equal(0, (await Import(fields)).FieldsUpdated);
    }

    [DbFact]
    public async Task Import_non_valido_non_modifica_nulla()
    {
        await Import(Entry(1, "Uno", 2001));
        await Assert.ThrowsAsync<ImportValidationException>(() => Import(Entry(2, "Due", 2002), Entry(2, "Doppio", 2002)));
        await Assert.ThrowsAsync<ImportValidationException>(() => Import(new JsonObject { ["title"] = "Senza id" }));
        Assert.Single(await Movies());
    }
}
