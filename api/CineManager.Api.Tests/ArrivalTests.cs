using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using CineManager.Api.Data;
using CineManager.Api.Tests.Support;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace CineManager.Api.Tests;

/// <summary><c>POST /api/app/movies</c> (§6.3), copertine (§7) e gestione degli arrivi dal sito (§6.2).</summary>
public class ArrivalTests(AppFixture fx) : IClassFixture<AppFixture>, IAsyncLifetime
{
    private AppFactory F => fx.Factory;
    private TestDevice _dev = null!;

    public async Task InitializeAsync()
    {
        if (TestDb.BaseConnection is null) return;
        await F.ResetAsync();
        F.Covers.Responder = _ => FakeHttp.Bytes(TmdbFixtures.Jpeg(), "image/jpeg");
        F.Covers.Requests.Clear();
        _dev = await F.PairAsync("alice");
    }

    public Task DisposeAsync()
    {
        _dev?.Dispose();
        return Task.CompletedTask;
    }

    private static StringContent Json(string json) => new(json, Encoding.UTF8, "application/json");

    private async Task<(HttpStatusCode Status, JsonNode? Body)> Post(object body, TestDevice? dev = null)
    {
        using var c = F.AppClient();
        var json = System.Text.Json.JsonSerializer.Serialize(body);
        var res = await c.SendAsync((dev ?? _dev).Request(HttpMethod.Post, "/api/app/movies", json));
        var text = await res.Content.ReadAsStringAsync();
        return (res.StatusCode, text.Length > 0 ? JsonNode.Parse(text) : null);
    }

    private async Task<int> Create(string title = "Il padrino", int year = 1972, string? ean = null, int? tmdbId = null,
        string? posterPath = null, TestDevice? dev = null)
    {
        var (status, body) = await Post(new
        {
            ean, tmdbId, posterPath, movie = new { title, year, director = new[] { "Francis Ford Coppola" } },
            confirmDuplicate = true,
        }, dev);
        Assert.True(status == HttpStatusCode.Created, body?.ToJsonString());
        return body!["id"]!.GetValue<int>();
    }

    private Task<Movie> Load(int id) => F.WithDbAsync(db => db.Movies.AsNoTracking().SingleAsync(m => m.Id == id));

    private async Task ImportTellico(string fieldsJson, string moviesJson)
    {
        using var admin = F.Client("root", "user,admin");
        var res = await admin.PostAsync("/api/import/tellico", Json($$"""{"fields":{{fieldsJson}},"movies":{{moviesJson}}}"""));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    // --- inserimento ---------------------------------------------------------------------------

    [DbFact]
    public async Task Inserimento_completo_con_copertina()
    {
        var (status, body) = await Post(new
        {
            ean = "8012-3456-78901", tmdbId = 238, posterPath = "/padrino.jpg",
            movie = new
            {
                title = "Il padrino", year = 1972, director = new[] { "Francis Ford Coppola" },
                genre = new[] { "Dramma", "Crime", "Dramma" },
                cast = new[] { new { actor = "Marlon Brando", role = "Vito Corleone" } },
                medium = "dvd", plot = "…", nationality = "USA",
            },
        });
        Assert.Equal(HttpStatusCode.Created, status);
        var id = body!["id"]!.GetValue<int>();
        Assert.True(id >= CinemaDbContext.MovieIdSequenceStart);

        var m = await Load(id);
        Assert.Equal((MovieSources.App, "alice", _dev.Id, 238, "8012345678901"),
            (m.Source, m.CreatedBy, m.CreatedByDevice!.Value, m.TmdbId!.Value, m.Ean));
        Assert.Null(m.TellicoId);
        var data = JsonNode.Parse(m.Data)!;
        Assert.Equal(DateTime.Now.ToString("yyyy-MM-dd"), data["cdate"]!.GetValue<string>());
        Assert.Equal("8012345678901", data["ean"]!.GetValue<string>());
        Assert.Equal("DVD", data["medium"]!.GetValue<string>()); // valore ammesso del campo
        Assert.Equal(["Dramma", "Crime"], data["genre"]!.AsArray().Select(g => g!.GetValue<string>()));
        Assert.Equal(["USA"], data["nationality"]!.AsArray().Select(g => g!.GetValue<string>())); // multiplo
        Assert.Equal($"cm-{id}.jpg", data["cover"]!.GetValue<string>());

        var uri = Assert.Single(F.Covers.Requests);
        Assert.Equal("https://image.tmdb.org/t/p/w500/padrino.jpg", uri.ToString());
        Assert.True(File.Exists(Path.Combine(F.CoversPath, $"cm-{id}.jpg")));
        Assert.Empty(Directory.GetFiles(F.CoversPath, ".tmp-*"));

        // Compare nella collezione come gli altri film.
        using var site = F.Client("bob");
        var coll = JsonNode.Parse(await site.GetStringAsync("/api/collection"))!["movies"]!.AsArray();
        Assert.Contains(coll, mv => mv!["id"]!.GetValue<int>() == id);
    }

    public static TheoryData<string> CoverFailures => new() { "redirect", "html", "troppo_grande", "contenuto", "errore", "rete" };

    [DbTheory]
    [MemberData(nameof(CoverFailures))]
    public async Task Copertina_non_valida_film_salvato_senza(string caso)
    {
        F.Covers.Responder = caso switch
        {
            "redirect" => _ =>
            {
                var r = new HttpResponseMessage(HttpStatusCode.Found);
                r.Headers.Location = new Uri("http://169.254.169.254/latest/meta-data");
                return r;
            },
            "html" => _ => FakeHttp.Bytes(TmdbFixtures.Jpeg(), "text/html"),
            "troppo_grande" => _ => FakeHttp.Bytes(TmdbFixtures.Jpeg(5 * 1024 * 1024 + 1), "image/jpeg"),
            "contenuto" => _ => FakeHttp.Bytes("<html>"u8.ToArray(), "image/jpeg"),
            "errore" => _ => new HttpResponseMessage(HttpStatusCode.InternalServerError),
            _ => _ => throw new HttpRequestException("rete giù"),
        };
        var id = await Create(posterPath: "/padrino.jpg");
        var data = JsonNode.Parse((await Load(id)).Data)!;
        Assert.Null(data["cover"]);
        Assert.False(Directory.Exists(F.CoversPath) && Directory.GetFiles(F.CoversPath, $"cm-{id}.*").Length > 0);
        Assert.Single(F.Covers.Requests); // nessun redirect seguito
    }

    [DbFact]
    public void Client_delle_copertine_senza_redirect_automatici()
    {
        // Configurazione reale (non quella dei test): il primary handler non segue i redirect.
        using var real = new ApiFactory();
        var factory = real.Services.GetRequiredService<IHttpMessageHandlerFactory>();
        HttpMessageHandler? h = factory.CreateHandler(nameof(Api.Movies.CoverDownloader));
        while (h is DelegatingHandler d) h = d.InnerHandler;
        var sockets = Assert.IsType<SocketsHttpHandler>(h);
        Assert.False(sockets.AllowAutoRedirect);
    }

    [Theory]
    [InlineData("/abc_DEF-1.jpg", true)]
    [InlineData("/a.png", true)]
    [InlineData("/a.jpeg", true)]
    [InlineData("/a.gif", false)]
    [InlineData("a.jpg", false)]
    [InlineData("/../a.jpg", false)]
    [InlineData("/a/b.jpg", false)]
    [InlineData("//evil.example/a.jpg", false)]
    [InlineData("/a.jpg?x=1", false)]
    public void PosterPath_validato(string path, bool ok) =>
        Assert.Equal(ok, Api.Movies.CoverDownloader.IsValidPosterPath(path));

    [DbFact]
    public async Task PosterPath_non_valido_400_senza_download()
    {
        var (status, _) = await Post(new { posterPath = "https://evil.example/x.jpg", movie = new { title = "X" } });
        Assert.Equal(HttpStatusCode.BadRequest, status);
        Assert.Empty(F.Covers.Requests);
    }

    [DbFact]
    public async Task Stesso_EAN_409_ean()
    {
        var id = await Create(ean: "8012345678901");
        var (status, body) = await Post(new { ean = "8012345678901", movie = new { title = "Altro", year = 2001 } });
        Assert.Equal(HttpStatusCode.Conflict, status);
        Assert.Equal("ean", body!["reason"]!.GetValue<string>());
        Assert.Equal(id, body["existingId"]!.GetValue<int>());
        Assert.Equal("Il padrino", body["title"]!.GetValue<string>());
        // Anche con confirmDuplicate: l'EAN è univoco.
        var (again, _) = await Post(new { ean = "8012345678901", movie = new { title = "Altro" }, confirmDuplicate = true });
        Assert.Equal(HttpStatusCode.Conflict, again);
    }

    [DbFact]
    public async Task Possibile_duplicato_409_poi_confermato()
    {
        await ImportTellico("[]", """[{"id":5,"title":"Il Padrino","year":1972}]""");
        var (status, body) = await Post(new { movie = new { title = "il padrino", year = 1972 } });
        Assert.Equal(HttpStatusCode.Conflict, status);
        Assert.Equal("possible_duplicate", body!["reason"]!.GetValue<string>());
        var c = Assert.Single(body["candidates"]!.AsArray())!;
        Assert.Equal((5, "Il Padrino", 1972), (c["id"]!.GetValue<int>(), c["title"]!.GetValue<string>(), c["year"]!.GetValue<int>()));

        // Anno diverso: nessun duplicato.
        var (other, _) = await Post(new { movie = new { title = "Il padrino", year = 1990 } });
        Assert.Equal(HttpStatusCode.Created, other);

        var (confirmed, _) = await Post(new { movie = new { title = "il padrino", year = 1972 }, confirmDuplicate = true });
        Assert.Equal(HttpStatusCode.Created, confirmed);
    }

    [DbFact]
    public async Task Stesso_tmdb_id_e_possibile_duplicato()
    {
        var id = await Create(tmdbId: 238);
        var (status, body) = await Post(new { tmdbId = 238, movie = new { title = "The Godfather", year = 1972 } });
        Assert.Equal(HttpStatusCode.Conflict, status);
        Assert.Equal(id, body!["candidates"]![0]!["id"]!.GetValue<int>());
    }

    public static TheoryData<string, string> InvalidMovies => new()
    {
        { """{"title":"X","sconosciuto":"a"}""", "sconosciuto" },
        { """{"title":"X","year":1700}""", "year" },
        { """{"title":"X","year":"abc"}""", "year" },
        { """{"title":"X","medium":"Laserdisc"}""", "medium" },
        { """{"title":"X","cover":"x.jpg"}""", "cover" },
        { """{"title":"X","cdate":"2020-01-01"}""", "cdate" },
        { """{"title":"X","id":3}""", "id" },
        { """{"title":"X","ean":"8012345678901"}""", "ean" },
        { """{"title":["A","B"]}""", "title" },
        { """{"title":"X","running-time":-5}""", "running-time" },
        { """{"title":"X","cast":"Brando"}""", "cast" },
        { """{"title":"X","rating":3}""", "" }, // rating esiste nei campi standard ed è valido
    };

    [DbTheory]
    [MemberData(nameof(InvalidMovies))]
    public async Task Validazione_dei_campi(string movieJson, string field)
    {
        using var c = F.AppClient();
        var json = $$"""{"movie":{{movieJson}},"confirmDuplicate":true}""";
        var res = await c.SendAsync(_dev.Request(HttpMethod.Post, "/api/app/movies", json));
        if (field == "")
        {
            Assert.Equal(HttpStatusCode.Created, res.StatusCode);
            return;
        }
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        var errors = JsonNode.Parse(await res.Content.ReadAsStringAsync())!["errors"]!.AsObject();
        Assert.True(errors.ContainsKey(field), errors.ToJsonString());
    }

    [DbFact]
    public async Task Validazione_titolo_obbligatorio_e_proprieta_sconosciute()
    {
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(new { movie = new { year = 2000 } })).Status);
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(new { movie = new { title = "X" }, extra = 1 })).Status);
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(new { ean = "12", movie = new { title = "X" } })).Status);
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(new { tmdbId = -1, movie = new { title = "X" } })).Status);
    }

    [DbFact]
    public async Task Campi_della_collezione_dependent_e_personalizzati()
    {
        await ImportTellico("""
            [{"name":"title","title":"Titolo","type":"1","flags":0},
             {"name":"year","title":"Anno","type":"6","flags":0},
             {"name":"medium","title":"Supporto","type":"3","flags":0,"allowed":["DVD","Blu-ray"]},
             {"name":"calcolato","title":"Calcolato","type":"11","flags":0},
             {"name":"visto","title":"Visto","type":"4","flags":0},
             {"name":"acquisto","title":"Acquisto","type":"12","flags":0}]
            """, "[]");
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(new { movie = new { title = "X", calcolato = "a" } })).Status);
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(new { movie = new { title = "X", medium = "VHS" } })).Status);
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(new { movie = new { title = "X", acquisto = "31/12/2020" } })).Status);
        // director non è nella collezione importata: sconosciuto.
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(new { movie = new { title = "X", director = "Y" } })).Status);

        using (var admin = F.Client("root", "user,admin"))
        {
            var res = await admin.PostAsJsonAsync("/api/fields", new { name = "edizione", title = "Edizione", type = "line" });
            Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        }
        var (status, body) = await Post(new
        {
            movie = new { title = "Y", medium = "blu-ray", visto = true, acquisto = "2020-12-31", edizione = "Steelbook" },
        });
        Assert.Equal(HttpStatusCode.Created, status);
        var data = JsonNode.Parse((await Load(body!["id"]!.GetValue<int>())).Data)!;
        Assert.Equal(("Blu-ray", "true", "2020-12-31", "Steelbook"),
            (data["medium"]!.GetValue<string>(), data["visto"]!.GetValue<string>(), data["acquisto"]!.GetValue<string>(),
             data["edizione"]!.GetValue<string>()));
    }

    // --- arrivi dal sito -----------------------------------------------------------------------

    [DbFact]
    public async Task Arrivi_propri_per_l_utente_tutti_per_l_admin()
    {
        var a = await Create("A", 2001);
        using var bobDev = await F.PairAsync("bob");
        var b = await Create("B", 2002, dev: bobDev);
        await ImportTellico("[]", """[{"id":9,"title":"Da Tellico"}]""");

        using var alice = F.Client("alice");
        var list = JsonNode.Parse(await alice.GetStringAsync("/api/arrivals?scope=new"))!.AsArray();
        var item = Assert.Single(list)!;
        Assert.Equal(a, item["id"]!.GetValue<int>());
        Assert.Equal(("alice", "ALICE", "app"), (item["createdBy"]!.GetValue<string>(), item["createdByName"]!.GetValue<string>(),
            item["source"]!.GetValue<string>()));
        Assert.Equal("A", item["movie"]!["title"]!.GetValue<string>());
        Assert.Equal(a, item["movie"]!["id"]!.GetValue<int>());
        Assert.Null(item["exportedAt"]);

        using var admin = F.Client("root", "user,admin");
        var all = JsonNode.Parse(await admin.GetStringAsync("/api/arrivals?scope=app"))!.AsArray();
        Assert.Equal([b, a], all.Select(x => x!["id"]!.GetValue<int>()));

        Assert.Equal(HttpStatusCode.BadRequest, (await alice.GetAsync("/api/arrivals?scope=all")).StatusCode);
        using var anon = F.Client(user: null);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.GetAsync("/api/arrivals")).StatusCode);
    }

    [DbFact]
    public async Task Patch_dell_arrivo()
    {
        var id = await Create("Il padrin", 1927, ean: "8012345678901");
        using var alice = F.Client("alice");
        var res = await alice.PatchAsync($"/api/movies/{id}", Json("""{"movie":{"title":"Il padrino","year":1972,"director":[],"ean":"0801234567890"}}"""));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var o = JsonNode.Parse(await res.Content.ReadAsStringAsync())!;
        Assert.Equal(id, o["id"]!.GetValue<int>());
        Assert.Equal("0801234567890", o["ean"]!.GetValue<string>());
        Assert.Equal("Il padrino", o["movie"]!["title"]!.GetValue<string>());
        Assert.Null(o["movie"]!["director"]); // [] svuota il campo multiplo
        var m = await Load(id);
        Assert.Equal("0801234567890", m.Ean);
        Assert.Equal("0801234567890", JsonNode.Parse(m.Data)!["ean"]!.GetValue<string>());

        Assert.Equal(HttpStatusCode.BadRequest,
            (await alice.PatchAsync($"/api/movies/{id}", Json("""{"movie":{"year":"x"}}"""))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest,
            (await alice.PatchAsync($"/api/movies/{id}", Json("""{"movie":{"title":null}}"""))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest,
            (await alice.PatchAsync($"/api/movies/{id}", Json("""{"title":"X"}"""))).StatusCode);

        var other = await Create("Altro", 2000, ean: "8000000000001");
        var conflict = await alice.PatchAsync($"/api/movies/{other}", Json("""{"movie":{"ean":"0801234567890"}}"""));
        Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        Assert.Equal("ean", JsonNode.Parse(await conflict.Content.ReadAsStringAsync())!["reason"]!.GetValue<string>());
    }

    [DbFact]
    public async Task Patch_e_delete_permessi()
    {
        var id = await Create();
        await ImportTellico("[]", """[{"id":9,"title":"Da Tellico"}]""");
        using var bob = F.Client("bob");
        Assert.Equal(HttpStatusCode.Forbidden, (await bob.PatchAsync($"/api/movies/{id}", Json("""{"movie":{"title":"Z"}}"""))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await bob.DeleteAsync($"/api/movies/{id}")).StatusCode);
        using var admin = F.Client("root", "user,admin");
        Assert.Equal(HttpStatusCode.OK, (await admin.PatchAsync($"/api/movies/{id}", Json("""{"movie":{"title":"Z"}}"""))).StatusCode);
        // I film di Tellico non si toccano da qui, nemmeno l'admin.
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PatchAsync("/api/movies/9", Json("""{"movie":{"title":"Z"}}"""))).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await admin.DeleteAsync("/api/movies/9")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.DeleteAsync("/api/movies/424242")).StatusCode);
        using var noCsrf = F.Client("alice", csrf: false);
        Assert.Equal(HttpStatusCode.BadRequest, (await noCsrf.DeleteAsync($"/api/movies/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.DeleteAsync($"/api/movies/{id}")).StatusCode);
    }

    [DbFact]
    public async Task Delete_cancella_stato_e_copertina()
    {
        var id = await Create(posterPath: "/padrino.jpg");
        Assert.True(File.Exists(Path.Combine(F.CoversPath, $"cm-{id}.jpg")));
        using var alice = F.Client("alice");
        Assert.Equal(HttpStatusCode.NoContent, (await alice.PutAsync($"/api/state/{id}", Json("""{"status":"seen","rating":4}"""))).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await alice.DeleteAsync($"/api/movies/{id}")).StatusCode);
        Assert.False(await F.WithDbAsync(db => db.Movies.AnyAsync(m => m.Id == id)));
        Assert.False(await F.WithDbAsync(db => db.UserMovieStates.AnyAsync(s => s.MovieId == id)));
        Assert.False(File.Exists(Path.Combine(F.CoversPath, $"cm-{id}.jpg")));
        Assert.Equal(HttpStatusCode.NotFound, (await alice.DeleteAsync($"/api/movies/{id}")).StatusCode);
    }
}
