using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CineManager.Api.Data;
using CineManager.Api.Tests.Support;
using Microsoft.EntityFrameworkCore;

namespace CineManager.Api.Tests;

/// <summary>Endpoint del sito con l'autenticazione di test.</summary>
public class HttpTests(ApiFixture fx) : IClassFixture<ApiFixture>, IAsyncLifetime
{
    private ApiFactory F => fx.Factory;

    public Task InitializeAsync() => TestDb.BaseConnection is null ? Task.CompletedTask : F.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    private static StringContent Json(string json) => new(json, Encoding.UTF8, "application/json");

    private async Task SeedMovies(params int[] ids)
    {
        using var admin = F.Client("root", "user,admin");
        var movies = new JsonArray(ids.Select(i => (JsonNode)new JsonObject
        {
            ["id"] = i, ["title"] = $"Film {i}", ["year"] = 2000 + i,
            ["cast"] = new JsonArray(new JsonObject { ["actor"] = "A", ["role"] = "R" }),
        }).ToArray());
        var body = new JsonObject
        {
            ["fields"] = new JsonArray(
                new JsonObject { ["name"] = "title", ["title"] = "Titolo", ["type"] = "1", ["flags"] = 0, ["multiple"] = false, ["groupable"] = false, ["allowed"] = null },
                new JsonObject { ["name"] = "year", ["title"] = "Anno", ["type"] = 6, ["flags"] = 2 }),
            ["movies"] = movies,
        };
        var res = await admin.PostAsync("/api/import/tellico", Json(body.ToJsonString()));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    private static async Task<JsonObject> ReadObj(HttpResponseMessage res) =>
        (JsonObject)JsonNode.Parse(await res.Content.ReadAsStringAsync())!;

    // --- health, me, collection --------------------------------------------------------------

    [DbFact]
    public async Task Health_anonimo()
    {
        using var c = F.Client(user: null);
        var res = await c.GetAsync("/api/health");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var o = await ReadObj(res);
        Assert.Equal(("ok", "ok"), (o["status"]!.GetValue<string>(), o["db"]!.GetValue<string>()));
    }

    [DbFact]
    public async Task Me_senza_sessione_401_problem_json()
    {
        using var c = F.Client(user: null);
        var res = await c.GetAsync("/api/me");
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Null(res.Headers.Location);
        Assert.Equal("application/problem+json", res.Content.Headers.ContentType?.MediaType);
    }

    [DbFact]
    public async Task Me_restituisce_sub_nome_e_ruoli()
    {
        using var c = F.Client("bob", "user,admin");
        var o = await ReadObj(await c.GetAsync("/api/me"));
        Assert.Equal("bob", o["sub"]!.GetValue<string>());
        Assert.Equal("BOB", o["name"]!.GetValue<string>());
        Assert.Equal(["user", "admin"], o["roles"]!.AsArray().Select(r => r!.GetValue<string>()));
    }

    [DbFact]
    public async Task Collection_restituisce_data_con_id_e_campi_ordinati()
    {
        await SeedMovies(3, 1);
        using var c = F.Client();
        var res = await c.GetAsync("/api/collection");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var o = await ReadObj(res);
        var movies = o["movies"]!.AsArray();
        Assert.Equal([1, 3], movies.Select(m => m!["id"]!.GetValue<int>()));
        Assert.Equal("Film 1", movies[0]!["title"]!.GetValue<string>());
        Assert.Equal("R", movies[0]!["cast"]![0]!["role"]!.GetValue<string>());
        var fields = o["fields"]!.AsArray();
        Assert.Equal(["title", "year"], fields.Select(f => f!["name"]!.GetValue<string>()));
        var year = fields[1]!.AsObject();
        Assert.Equal("number", year["type"]!.GetValue<string>());
        Assert.True(year["groupable"]!.GetValue<bool>());
        Assert.Equal("tellico", year["origin"]!.GetValue<string>());
        Assert.Equal(3, year["groupMinSize"]!.GetValue<int>());
        Assert.True(year.ContainsKey("allowed") && year["allowed"] is null);
        foreach (var k in new[] { "title", "multiple", "inForm", "ordinal" }) Assert.True(year.ContainsKey(k), k);
    }

    // --- stato --------------------------------------------------------------------------------

    [DbFact]
    public async Task Put_state_distingue_assente_da_null()
    {
        await SeedMovies(1, 2);
        using var c = F.Client("carla");

        Assert.Equal(HttpStatusCode.NoContent, (await c.PutAsync("/api/state/1", Json("""{"status":"seen"}"""))).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await c.PutAsync("/api/state/1", Json("""{"rating":4}"""))).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await c.PutAsync("/api/state/2", Json("""{"status":"watchlist"}"""))).StatusCode);

        var s = await ReadObj(await c.GetAsync("/api/state"));
        Assert.Equal("seen", s["status"]!["1"]!.GetValue<string>()); // il voto non ha toccato lo stato
        Assert.Equal(4, s["rating"]!["1"]!.GetValue<int>());
        Assert.Equal("watchlist", s["status"]!["2"]!.GetValue<string>());
        Assert.False(s["rating"]!.AsObject().ContainsKey("2"));

        // null = "nessuno": toglie solo quel campo
        await c.PutAsync("/api/state/1", Json("""{"status":null}"""));
        s = await ReadObj(await c.GetAsync("/api/state"));
        Assert.False(s["status"]!.AsObject().ContainsKey("1"));
        Assert.Equal(4, s["rating"]!["1"]!.GetValue<int>());

        // entrambi null ⇒ la riga sparisce
        await c.PutAsync("/api/state/1", Json("""{"rating":null}"""));
        var rows = await F.WithDbAsync(db => db.UserMovieStates.CountAsync(x => x.UserSub == "carla" && x.MovieId == 1));
        Assert.Equal(0, rows);

        // null su una riga che non esiste: nessun errore, nessuna riga
        Assert.Equal(HttpStatusCode.NoContent, (await c.PutAsync("/api/state/2", Json("""{"rating":null}"""))).StatusCode);
    }

    [DbFact]
    public async Task Put_state_validazione_e_404()
    {
        await SeedMovies(1);
        using var c = F.Client();
        Assert.Equal(HttpStatusCode.NotFound, (await c.PutAsync("/api/state/999", Json("""{"status":"seen"}"""))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PutAsync("/api/state/1", Json("{}"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PutAsync("/api/state/1", Json("""{"status":"visto"}"""))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PutAsync("/api/state/1", Json("""{"rating":6}"""))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PutAsync("/api/state/1", Json("""{"rating":"3"}"""))).StatusCode);
    }

    [DbFact]
    public async Task Stato_separato_per_utente()
    {
        await SeedMovies(1);
        using var a = F.Client("u1");
        using var b = F.Client("u2");
        await a.PutAsync("/api/state/1", Json("""{"status":"seen"}"""));
        var sb = await ReadObj(await b.GetAsync("/api/state"));
        Assert.Empty(sb["status"]!.AsObject());
    }

    [DbFact]
    public async Task Migrate_scrive_solo_dove_manca_un_valore()
    {
        await SeedMovies(1, 2, 3);
        using var c = F.Client("dora");
        await c.PutAsync("/api/state/1", Json("""{"status":"watchlist"}"""));

        var res = await c.PostAsync("/api/state/migrate", Json("""
            { "status": { "1": "seen", "2": "seen", "3": null, "999": "seen", "x": "seen" },
              "rating": { "1": 5, "2": null, "3": 2, "4": 7 } }
            """));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(3, (await ReadObj(res))["imported"]!.GetValue<int>()); // status 2, rating 1, rating 3

        var s = await ReadObj(await c.GetAsync("/api/state"));
        Assert.Equal("watchlist", s["status"]!["1"]!.GetValue<string>()); // scelta esistente non toccata
        Assert.Equal("seen", s["status"]!["2"]!.GetValue<string>());
        Assert.False(s["status"]!.AsObject().ContainsKey("3"));
        Assert.Equal(5, s["rating"]!["1"]!.GetValue<int>());
        Assert.Equal(2, s["rating"]!["3"]!.GetValue<int>());

        // Idempotente
        res = await c.PostAsync("/api/state/migrate", Json("""{ "status": { "2": "watchlist" }, "rating": { "3": 4 } }"""));
        Assert.Equal(0, (await ReadObj(res))["imported"]!.GetValue<int>());
    }

    // --- permessi e CSRF ----------------------------------------------------------------------

    [DbTheory]
    [InlineData("GET", "/api/me")]
    [InlineData("GET", "/api/collection")]
    [InlineData("GET", "/api/state")]
    [InlineData("PUT", "/api/state/1")]
    [InlineData("POST", "/api/state/migrate")]
    [InlineData("POST", "/api/import/tellico")]
    [InlineData("POST", "/api/import/tellico/images")]
    public async Task Senza_sessione_401(string method, string path)
    {
        using var c = F.Client(user: null);
        var res = await c.SendAsync(new HttpRequestMessage(new HttpMethod(method), path) { Content = method == "GET" ? null : Json("{}") });
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [DbTheory]
    [InlineData("GET", "/api/collection", "", HttpStatusCode.Forbidden)]
    [InlineData("GET", "/api/state", "", HttpStatusCode.Forbidden)]
    [InlineData("GET", "/api/me", "", HttpStatusCode.OK)]
    [InlineData("POST", "/api/import/tellico", "user", HttpStatusCode.Forbidden)]
    [InlineData("POST", "/api/import/tellico/images", "user", HttpStatusCode.Forbidden)]
    [InlineData("POST", "/api/import/tellico", "user,admin", HttpStatusCode.OK)]
    [InlineData("POST", "/api/import/tellico/images", "user,admin", HttpStatusCode.OK)]
    [InlineData("GET", "/api/collection", "user", HttpStatusCode.OK)]
    public async Task Ruoli_per_endpoint(string method, string path, string roles, HttpStatusCode expected)
    {
        using var c = F.Client("eva", roles);
        var body = path.EndsWith("images") ? """{"images":{}}""" : """{"fields":[],"movies":[]}""";
        var res = await c.SendAsync(new HttpRequestMessage(new HttpMethod(method), path) { Content = method == "GET" ? null : Json(body) });
        Assert.Equal(expected, res.StatusCode);
    }

    [DbTheory]
    [InlineData("PUT", "/api/state/1")]
    [InlineData("POST", "/api/state/migrate")]
    [InlineData("POST", "/api/import/tellico")]
    [InlineData("POST", "/api/auth/logout")]
    public async Task Scritture_senza_header_CSRF_rifiutate(string method, string path)
    {
        await SeedMovies(1);
        using var c = F.Client("frank", "user,admin", csrf: false);
        var res = await c.SendAsync(new HttpRequestMessage(new HttpMethod(method), path) { Content = Json("""{"status":"seen","fields":[],"movies":[]}""") });
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Contains("X-CM-Request", await res.Content.ReadAsStringAsync());

        var wrong = new HttpRequestMessage(new HttpMethod(method), path) { Content = Json("{}") };
        wrong.Headers.Add("X-CM-Request", "0");
        Assert.Equal(HttpStatusCode.BadRequest, (await c.SendAsync(wrong)).StatusCode);
    }

    // --- immagini e import via HTTP -----------------------------------------------------------

    [DbFact]
    public async Task Import_immagini_scrive_una_volta_e_rifiuta_nomi_non_validi()
    {
        using var c = F.Client("root", "user,admin");
        var png = Convert.ToBase64String([0x89, 0x50, 0x4E, 0x47, 1, 2, 3]);
        var res = await c.PostAsync("/api/import/tellico/images", Json($$$"""{"images":{"abc123.png":"{{{png}}}","def.jpeg":"{{{png}}}"}}"""));
        var o = await ReadObj(res);
        Assert.Equal((2, 0), (o["written"]!.GetValue<int>(), o["skipped"]!.GetValue<int>()));
        Assert.True(File.Exists(Path.Combine(F.CoversPath, "abc123.png")));
        Assert.Empty(Directory.GetFiles(F.CoversPath, ".tmp-*"));

        o = await ReadObj(await c.PostAsync("/api/import/tellico/images", Json($$$"""{"images":{"abc123.png":"{{{png}}}","nuovo.png":"{{{png}}}"}}""")));
        Assert.Equal((1, 1), (o["written"]!.GetValue<int>(), o["skipped"]!.GetValue<int>()));

        res = await c.PostAsync("/api/import/tellico/images", Json($$$"""{"images":{"ok.png":"{{{png}}}","../evil.png":"{{{png}}}"}}"""));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.False(File.Exists(Path.Combine(F.CoversPath, "ok.png"))); // lotto rifiutato per intero
        res = await c.PostAsync("/api/import/tellico/images", Json("""{"images":{"x.png":"non base64!"}}"""));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [DbFact]
    public async Task Import_tellico_via_http_riepilogo()
    {
        using var c = F.Client("root", "user,admin");
        var res = await c.PostAsync("/api/import/tellico", Json("""
            { "fields": [ { "name": "title", "title": "Titolo", "type": "1", "flags": 0, "multiple": false, "groupable": false, "allowed": null } ],
              "movies": [ { "id": 4, "title": "Quattro", "cdate": "2024-01-15", "custom": { "a": [1, 2] } } ] }
            """));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var o = await ReadObj(res);
        foreach (var k in new[] { "inserted", "updated", "linked", "unchanged", "missing", "fieldsUpdated" }) Assert.True(o.ContainsKey(k), k);
        Assert.Equal(1, o["inserted"]!.GetValue<int>());
        Assert.Equal(1, o["fieldsUpdated"]!.GetValue<int>());

        res = await c.PostAsync("/api/import/tellico", Json("""{ "fields": [], "movies": [ { "title": "senza id" } ] }"""));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("application/problem+json", res.Content.Headers.ContentType?.MediaType);
    }
}
