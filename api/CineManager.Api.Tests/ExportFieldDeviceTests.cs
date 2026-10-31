using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using CineManager.Api.Data;
using CineManager.Api.Movies;
using CineManager.Api.Tests.Support;
using Microsoft.EntityFrameworkCore;

namespace CineManager.Api.Tests;

/// <summary>Formato del CSV per Tellico (§9), senza host.</summary>
public class CsvUnitTests
{
    private static CollectionField F(string name, string title, string type, bool multiple = false, int ordinal = 0) =>
        new() { Name = name, Title = title, Type = type, Multiple = multiple, Ordinal = ordinal };

    [Fact]
    public void Intestazioni_dai_titoli_quoting_multipli_tabelle_bool_date()
    {
        var fields = new List<CollectionField>
        {
            F("title", "Titolo", FieldTypes.Line, ordinal: 0),
            F("director", "Regista", FieldTypes.Line, true, 1),
            F("cast", "Cast", FieldTypes.Table, ordinal: 2),
            F("visto", "Visto", FieldTypes.Bool, ordinal: 3),
            F("acquisto", "Data, acquisto", FieldTypes.Date, ordinal: 4),
            F("cover", "Copertina", FieldTypes.Image, ordinal: 5),
            F("calcolato", "Calcolato", FieldTypes.Dependent, ordinal: 6),
            F("cdate", "Creato", FieldTypes.Date, ordinal: 7),
            F("year", "Anno", FieldTypes.Number, ordinal: 8),
            F("tracce", "Tracce", FieldTypes.Table, ordinal: 9),
        };
        var data = (JsonObject)JsonNode.Parse("""
            { "title": "Il \"padrino\", parte 1", "director": ["Coppola", "Altri"],
              "cast": [ { "actor": "Brando", "role": "Vito" }, { "actor": "Pacino", "role": "" } ],
              "visto": "true", "acquisto": "20201231", "cover": "x.jpg", "calcolato": "z", "cdate": "2024-01-01",
              "year": 1972, "tracce": [["1", "Intro"], ["2", "Fine"]] }
            """)!;
        var csv = CsvExporter.Write(fields, "ean", [new CsvExporter.Row("8012345678901", data),
            new CsvExporter.Row(null, new JsonObject { ["title"] = "Riga\nnuova", ["visto"] = false })]);
        var lines = csv.Split("\r\n");
        Assert.Equal("Titolo,Regista,Cast,Visto,\"Data, acquisto\",Anno,Tracce,EAN", lines[0]);
        Assert.Equal("\"Il \"\"padrino\"\", parte 1\",Coppola; Altri,Brando::Vito; Pacino,true,2020-12-31,1972,1::Intro; 2::Fine,8012345678901", lines[1]);
        Assert.Equal("\"Riga\nnuova\",,,,,,,", lines[2]);
        Assert.Equal("", lines[3]);
        Assert.False(csv.StartsWith('﻿'));
    }

    [Fact]
    public void Colonna_barcode_dal_campo_della_collezione()
    {
        var fields = new List<CollectionField> { F("title", "Titolo", FieldTypes.Line), F("codice", "Codice a barre", FieldTypes.Line, ordinal: 1) };
        var csv = CsvExporter.Write(fields, "codice", [new CsvExporter.Row("123", new JsonObject { ["title"] = "A" })]);
        Assert.Equal("Titolo,Codice a barre\r\nA,123\r\n", csv);
    }

    [Fact]
    public void Senza_import_titoli_inglesi_di_Tellico()
    {
        var csv = CsvExporter.Write(FieldCatalog.Defaults, "ean", []);
        var header = csv.TrimEnd().Split(',');
        Assert.Contains("Title", header);
        Assert.Contains("Production Year", header);
        Assert.Contains("Director", header);
        Assert.DoesNotContain("Front Cover", header);
        Assert.Equal("EAN", header[^1]);
    }
}

/// <summary>ESPORTA CSV + mark, gestione dei campi, dispositivi e QR (§6.2).</summary>
public class ExportFieldDeviceTests(AppFixture fx) : IClassFixture<AppFixture>, IAsyncLifetime
{
    private AppFactory F => fx.Factory;

    public async Task InitializeAsync()
    {
        if (TestDb.BaseConnection is null) return;
        await F.ResetAsync();
        await F.WithDbAsync(db => db.Devices.ExecuteDeleteAsync());
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private static StringContent Json(string json) => new(json, Encoding.UTF8, "application/json");

    private async Task<int> Arrival(TestDevice dev, string title, string? ean = null)
    {
        using var c = F.AppClient();
        var body = System.Text.Json.JsonSerializer.Serialize(new { ean, movie = new { title, year = 2001 }, confirmDuplicate = true });
        var res = await c.SendAsync(dev.Request(HttpMethod.Post, "/api/app/movies", body));
        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        return JsonNode.Parse(await res.Content.ReadAsStringAsync())!["id"]!.GetValue<int>();
    }

    // --- export --------------------------------------------------------------------------------

    [DbFact]
    public async Task Export_csv_senza_effetti_poi_mark()
    {
        using var dev = await F.PairAsync("alice");
        var a = await Arrival(dev, "Primo, con virgola", "8012345678901");
        var b = await Arrival(dev, "Secondo");
        using var admin = F.Client("root", "user,admin");
        var imp = await admin.PostAsync("/api/import/tellico", Json("""{"fields":[],"movies":[{"id":3,"title":"Da Tellico"}]}"""));
        Assert.Equal(HttpStatusCode.OK, imp.StatusCode);

        var res = await admin.PostAsync("/api/export/csv", Json("""{"scope":"new"}"""));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("text/csv", res.Content.Headers.ContentType!.MediaType);
        Assert.Equal("utf-8", res.Content.Headers.ContentType.CharSet);
        Assert.StartsWith("attachment;", res.Content.Headers.ContentDisposition?.ToString() ?? res.Headers.GetValues("Content-Disposition").First());
        Assert.Equal($"{a},{b}", res.Headers.GetValues("X-CM-Movie-Ids").Single());
        Assert.Contains("X-CM-Movie-Ids", res.Headers.GetValues("Access-Control-Expose-Headers").Single());
        var bytes = await res.Content.ReadAsByteArrayAsync();
        Assert.False(bytes is [0xEF, 0xBB, 0xBF, ..]);
        var lines = Encoding.UTF8.GetString(bytes).Split("\r\n");
        Assert.Equal(4, lines.Length); // intestazione + 2 righe + riga vuota finale
        Assert.StartsWith("\"Primo, con virgola\"", lines[1]);
        Assert.EndsWith(",8012345678901", lines[1]);
        Assert.DoesNotContain("Da Tellico", lines[1] + lines[2]);

        // Nessun effetto collaterale: export ripetibile.
        Assert.False(await F.WithDbAsync(db => db.Movies.AnyAsync(m => m.ExportedAt != null)));
        var again = await admin.PostAsync("/api/export/csv", Json("{}"));
        Assert.Equal($"{a},{b}", again.Headers.GetValues("X-CM-Movie-Ids").Single());

        var mark = await admin.PostAsync("/api/export/mark", Json($$"""{"ids":[{{a}},{{b}},{{a}},999999]}"""));
        Assert.Equal(HttpStatusCode.OK, mark.StatusCode);
        Assert.Equal(2, JsonNode.Parse(await mark.Content.ReadAsStringAsync())!["marked"]!.GetValue<int>());

        var empty = await admin.PostAsync("/api/export/csv", Json("""{"scope":"new"}"""));
        Assert.Equal("", empty.Headers.GetValues("X-CM-Movie-Ids").Single());
        Assert.Single((await empty.Content.ReadAsStringAsync()).Split("\r\n", StringSplitOptions.RemoveEmptyEntries));

        var app = await admin.PostAsync("/api/export/csv", Json("""{"scope":"app"}"""));
        Assert.Equal($"{a},{b}", app.Headers.GetValues("X-CM-Movie-Ids").Single());
        var all = await admin.PostAsync("/api/export/csv", Json("""{"scope":"all"}"""));
        Assert.Contains("Da Tellico", await all.Content.ReadAsStringAsync());

        using var alice = F.Client("alice");
        var arrivals = JsonNode.Parse(await alice.GetStringAsync("/api/arrivals?scope=new"))!.AsArray();
        Assert.Empty(arrivals);
        Assert.Equal(2, JsonNode.Parse(await alice.GetStringAsync("/api/arrivals?scope=app"))!.AsArray().Count);
    }

    [DbFact]
    public async Task Export_e_mark_solo_admin_e_validazione()
    {
        using var user = F.Client("alice");
        Assert.Equal(HttpStatusCode.Forbidden, (await user.PostAsync("/api/export/csv", Json("""{"scope":"new"}"""))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.PostAsync("/api/export/mark", Json("""{"ids":[1]}"""))).StatusCode);
        using var admin = F.Client("root", "user,admin");
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsync("/api/export/csv", Json("""{"scope":"tutto"}"""))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsync("/api/export/mark", Json("""{"ids":["a"]}"""))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsync("/api/export/mark", Json("{}"))).StatusCode);
    }

    // --- campi ---------------------------------------------------------------------------------

    [DbFact]
    public async Task Campi_crud_e_purge()
    {
        using var admin = F.Client("root", "user,admin");
        var created = await admin.PostAsJsonAsync("/api/fields",
            new { name = "scaffale", title = "Scaffale", type = "choice", multiple = false, allowed = new[] { "A", "B" } });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var f = JsonNode.Parse(await created.Content.ReadAsStringAsync())!;
        Assert.Equal(("local", true, "choice"), (f["origin"]!.GetValue<string>(), f["inForm"]!.GetValue<bool>(), f["type"]!.GetValue<string>()));

        Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsJsonAsync("/api/fields", new { name = "scaffale", title = "X", type = "line" })).StatusCode);
        foreach (var bad in new object[]
                 {
                     new { name = "Scaffale", title = "X", type = "line" }, new { name = "1abc", title = "X", type = "line" },
                     new { name = "a_b", title = "X", type = "line" }, new { name = new string('a', 42), title = "X", type = "line" },
                     new { name = "ok", title = "X", type = "image" }, new { name = "ok", title = "X", type = "dependent" },
                     new { name = "ok", title = "", type = "line" }, new { name = "cdate", title = "X", type = "date" },
                     new { name = "ok", title = "X", type = "line", allowed = new[] { "a" } },
                     new { name = "ok", title = "X", type = "line", origin = "tellico" },
                 })
            Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync("/api/fields", bad)).StatusCode);

        var patched = await admin.PatchAsJsonAsync("/api/fields/scaffale", new { title = "Ripiano", groupable = true, groupMinSize = 2, inForm = false, ordinal = 50, allowed = new[] { "A", "B", "C" } });
        Assert.Equal(HttpStatusCode.OK, patched.StatusCode);
        var p = JsonNode.Parse(await patched.Content.ReadAsStringAsync())!;
        Assert.Equal(("Ripiano", true, 2, false, 3), (p["title"]!.GetValue<string>(), p["groupable"]!.GetValue<bool>(),
            p["groupMinSize"]!.GetValue<int>(), p["inForm"]!.GetValue<bool>(), p["allowed"]!.AsArray().Count));
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PatchAsJsonAsync("/api/fields/scaffale", new { type = "line" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.PatchAsJsonAsync("/api/fields/nessuno", new { title = "X" })).StatusCode);

        using var user = F.Client("alice");
        Assert.Equal(HttpStatusCode.OK, (await user.GetAsync("/api/fields")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.PostAsJsonAsync("/api/fields", new { name = "x", title = "X", type = "line" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.PatchAsJsonAsync("/api/fields/scaffale", new { title = "X" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.DeleteAsync("/api/fields/scaffale")).StatusCode);

        // Valori nel film: restano senza purge, spariscono con purge.
        var imp = await admin.PostAsync("/api/import/tellico", Json("""
            {"fields":[{"name":"title","title":"Titolo","type":"1","flags":0}],
             "movies":[{"id":1,"title":"A"},{"id":2,"title":"B"}]}
            """));
        Assert.Equal(HttpStatusCode.OK, imp.StatusCode);
        await F.WithDbAsync(db => db.Database.ExecuteSqlRawAsync(
            "UPDATE movies SET data = data || '{{\"scaffale\":\"A\",\"note\":\"n\"}}'::jsonb"));
        Assert.Equal(HttpStatusCode.Created, (await admin.PostAsJsonAsync("/api/fields", new { name = "note", title = "Note", type = "para" })).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await admin.DeleteAsync("/api/fields/scaffale")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.DeleteAsync("/api/fields/note?purge=true")).StatusCode);
        var data = await F.WithDbAsync(db => db.Movies.AsNoTracking().Select(m => m.Data).ToListAsync());
        Assert.All(data, d =>
        {
            var o = JsonNode.Parse(d)!.AsObject();
            Assert.True(o.ContainsKey("scaffale"));
            Assert.False(o.ContainsKey("note"));
        });
        Assert.False(await F.WithDbAsync(db => db.CollectionFields.AnyAsync(c => c.Name == "scaffale" || c.Name == "note")));

        // I campi di Tellico non si eliminano da qui.
        Assert.Equal(HttpStatusCode.Conflict, (await admin.DeleteAsync("/api/fields/title")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.DeleteAsync("/api/fields/nessuno")).StatusCode);
    }

    [DbFact]
    public async Task Campo_locale_prima_di_ogni_import_si_aggiunge_ai_campi_standard()
    {
        using var admin = F.Client("root", "user,admin");
        var created = await admin.PostAsJsonAsync("/api/fields", new { name = "edizione", title = "Edizione", type = "line" });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        Assert.True(JsonNode.Parse(await created.Content.ReadAsStringAsync())!["ordinal"]!.GetValue<int>() > 0);

        using var dev = await F.PairAsync("alice");
        using var c = F.AppClient();
        var body = """{"movie":{"title":"X","director":["Y"],"edizione":"Steelbook"}}""";
        Assert.Equal(HttpStatusCode.Created, (await c.SendAsync(dev.Request(HttpMethod.Post, "/api/app/movies", body))).StatusCode);
        var fields = JsonNode.Parse(await (await c.SendAsync(dev.Request(HttpMethod.Get, "/api/app/fields"))).Content.ReadAsStringAsync())!.AsArray();
        Assert.Contains(fields, f => f!["name"]!.GetValue<string>() == "director");
        Assert.Contains(fields, f => f!["name"]!.GetValue<string>() == "edizione");

        var csv = await (await admin.PostAsync("/api/export/csv", Json("{}"))).Content.ReadAsStringAsync();
        var header = csv.Split("\r\n")[0].Split(',');
        Assert.Equal(["Title", "Edizione", "EAN"], [header[0], header[^2], header[^1]]);
    }

    [DbFact]
    public async Task Campo_codice_a_barre_escluso_dal_modulo_dell_app()
    {
        // Il codice a barre si invia in "ean": nel corpo di movies verrebbe rifiutato.
        using var admin = F.Client("root", "user,admin");
        Assert.Equal(HttpStatusCode.Created,
            (await admin.PostAsJsonAsync("/api/fields", new { name = "ean", title = "EAN", type = "line" })).StatusCode);
        Assert.Contains(JsonNode.Parse(await admin.GetStringAsync("/api/fields"))!.AsArray(),
            f => f!["name"]!.GetValue<string>() == "ean");

        using var dev = await F.PairAsync("alice");
        using var c = F.AppClient();
        var fields = JsonNode.Parse(await (await c.SendAsync(dev.Request(HttpMethod.Get, "/api/app/fields"))).Content.ReadAsStringAsync())!.AsArray();
        Assert.Contains(fields, f => f!["name"]!.GetValue<string>() == "title");
        Assert.DoesNotContain(fields, f => f!["name"]!.GetValue<string>() == "ean");
    }

    // --- dispositivi ---------------------------------------------------------------------------

    [DbFact]
    public async Task Dispositivi_elenco_e_revoca()
    {
        using var mine = await F.PairAsync("alice", "Mio");
        using var bobs = await F.PairAsync("bob", "Di Bob");

        using var alice = F.Client("alice");
        var list = JsonNode.Parse(await alice.GetStringAsync("/api/devices"))!.AsArray();
        var d = Assert.Single(list)!;
        Assert.Equal((mine.Id.ToString(), "Mio", "alice", "ALICE"),
            (d["id"]!.GetValue<string>(), d["name"]!.GetValue<string>(), d["userSub"]!.GetValue<string>(), d["userName"]!.GetValue<string>()));
        Assert.Null(d["revokedAt"]);
        Assert.NotNull(d["createdAt"]);
        Assert.True(d.AsObject().ContainsKey("lastSeenAt"));

        Assert.Equal(HttpStatusCode.Forbidden, (await alice.GetAsync("/api/devices?all=true")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await alice.DeleteAsync($"/api/devices/{bobs.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await alice.DeleteAsync($"/api/devices/{Guid.NewGuid()}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await alice.DeleteAsync($"/api/devices/{mine.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await alice.DeleteAsync($"/api/devices/{mine.Id}")).StatusCode); // idempotente

        using var app = F.AppClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await app.SendAsync(mine.Request(HttpMethod.Get, "/api/app/me"))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await app.SendAsync(bobs.Request(HttpMethod.Get, "/api/app/me"))).StatusCode);

        using var admin = F.Client("root", "user,admin");
        var all = JsonNode.Parse(await admin.GetStringAsync("/api/devices?all=true"))!.AsArray();
        Assert.Equal(2, all.Count);
        Assert.NotNull(all.Single(x => x!["id"]!.GetValue<string>() == bobs.Id.ToString())!["lastSeenAt"]);
        Assert.Empty(JsonNode.Parse(await admin.GetStringAsync("/api/devices"))!.AsArray()); // senza all: solo i propri
        Assert.Equal(HttpStatusCode.NoContent, (await admin.DeleteAsync($"/api/devices/{bobs.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await app.SendAsync(bobs.Request(HttpMethod.Get, "/api/app/me"))).StatusCode);
    }

    [DbFact]
    public async Task Admin_revoca_tutti_i_dispositivi_e_le_sessioni()
    {
        using var d1 = await F.PairAsync("carla");
        using var d2 = await F.PairAsync("carla");
        using var other = await F.PairAsync("dario");

        using var user = F.Client("alice");
        Assert.Equal(HttpStatusCode.Forbidden, (await user.DeleteAsync("/api/users/carla/devices")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.DeleteAsync("/api/users/carla/sessions")).StatusCode);

        using var admin = F.Client("root", "user,admin");
        Assert.Equal(HttpStatusCode.NoContent, (await admin.DeleteAsync("/api/users/carla/devices")).StatusCode);
        using var app = F.AppClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await app.SendAsync(d1.Request(HttpMethod.Get, "/api/app/me"))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await app.SendAsync(d2.Request(HttpMethod.Get, "/api/app/me"))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await app.SendAsync(other.Request(HttpMethod.Get, "/api/app/me"))).StatusCode);

        var before = await F.WithDbAsync(db => db.Users.AsNoTracking().Where(u => u.Sub == "carla").Select(u => u.SecurityStamp).SingleAsync());
        Assert.Equal(HttpStatusCode.NoContent, (await admin.DeleteAsync("/api/users/carla/sessions")).StatusCode);
        var after = await F.WithDbAsync(db => db.Users.AsNoTracking().Where(u => u.Sub == "carla").Select(u => u.SecurityStamp).SingleAsync());
        Assert.NotEqual(before, after);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.DeleteAsync("/api/users/nessuno/sessions")).StatusCode);
    }

    [DbFact]
    public async Task Qr_di_download_dell_apk()
    {
        using var user = F.Client("alice");
        var res = await user.GetAsync("/api/app-download-qr.svg");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("image/svg+xml", res.Content.Headers.ContentType!.MediaType);
        Assert.Contains("<svg", await res.Content.ReadAsStringAsync());
        using var anon = F.Client(user: null);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.GetAsync("/api/app-download-qr.svg")).StatusCode);
    }
}
