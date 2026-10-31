using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using CineManager.Api.Devices;
using CineManager.Api.Infrastructure;
using CineManager.Api.Lookup;
using CineManager.Api.Movies;
using CineManager.Api.Tests.Support;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace CineManager.Api.Tests;

/// <summary>Pulizia dei titoli prodotto e mappatura TMDb (§7), senza rete.</summary>
public class LookupUnitTests
{
    [Theory]
    [InlineData("Il Padrino (DVD) [Edizione Speciale]", "Il Padrino", null)]
    [InlineData("Ritorno al futuro 1985 Blu-ray", "Ritorno al futuro", 1985)]
    [InlineData("Alien (1979) [Blu-ray] [Import]", "Alien", 1979)]
    [InlineData("1917 [Blu-ray]", "1917", null)]
    [InlineData("Inception - Steelbook 4K Ultra HD + Blu-ray", "Inception", null)]
    [InlineData("Shining - Edizione Speciale 2 Dischi DVD", "Shining", null)]
    [InlineData("", "", null)]
    public void Pulizia_del_titolo_prodotto(string product, string title, int? year)
    {
        var c = ProductTitleCleaner.Clean(product, 2026);
        Assert.Equal((title, year), (c.Title, c.Year));
    }

    private static TmdbMovie Godfather() =>
        JsonSerializer.Deserialize<TmdbMovie>(TmdbFixtures.Godfather, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower, PropertyNameCaseInsensitive = true,
        })!;

    [Fact]
    public void Mappatura_TMDb_come_il_parser()
    {
        var full = TmdbMapper.FullDraft(Godfather());
        Assert.Equal("Il padrino", full["title"]!.GetValue<string>());
        Assert.Equal("The Godfather", full["original-title"]!.GetValue<string>());
        Assert.Equal(1972, full["year"]!.GetValue<int>());
        Assert.Equal(175, full["running-time"]!.GetValue<int>());
        Assert.Equal(["Dramma", "Crime"], full["genre"]!.AsArray().Select(n => n!.GetValue<string>()));
        Assert.Equal(["Francis Ford Coppola"], full["director"]!.AsArray().Select(n => n!.GetValue<string>()));
        Assert.Equal(["USA"], full["nationality"]!.AsArray().Select(n => n!.GetValue<string>()));
        Assert.Equal(["Inglese", "Italiano", "Latino"], full["language"]!.AsArray().Select(n => n!.GetValue<string>()));
        var cast = full["cast"]!.AsArray();
        Assert.Equal("Marlon Brando", cast[0]!["actor"]!.GetValue<string>()); // ordinato per "order"
        Assert.Equal("Don Vito Corleone", cast[0]!["role"]!.GetValue<string>());
    }

    [Fact]
    public void Bozza_limitata_ai_campi_della_collezione()
    {
        var draft = TmdbMapper.ToDraft(TmdbMapper.FullDraft(Godfather()), FieldCatalog.Defaults);
        Assert.False(draft.ContainsKey("original-title")); // non definito nei campi standard
        Assert.True(draft.ContainsKey("cast"));
        Assert.Equal("1972", draft["year"]!.ToJsonString());

        var fields = new List<Data.CollectionField>
        {
            new() { Name = "title", Title = "Titolo", Type = Data.FieldTypes.Line },
            new() { Name = "original-title", Title = "Titolo originale", Type = Data.FieldTypes.Line },
            new() { Name = "genre", Title = "Genere", Type = Data.FieldTypes.Line, Multiple = false },
        };
        var custom = TmdbMapper.ToDraft(TmdbMapper.FullDraft(Godfather()), fields);
        Assert.Equal("The Godfather", custom["original-title"]!.GetValue<string>());
        Assert.Equal("Dramma", custom["genre"]!.GetValue<string>()); // singolo: primo valore
        Assert.False(custom.ContainsKey("year"));
    }

    [Fact]
    public async Task Versione_minima_in_cache_e_salto_se_irraggiungibile()
    {
        var http = new FakeHttp { Responder = _ => FakeHttp.Json("""{"minSupportedCode":10200}""") };
        var clock = new ManualClock(DateTimeOffset.UtcNow);
        var provider = new AppVersionProvider(new SingleClientFactory(http),
            Options.Create(new AppOptions { VersionUrl = "http://web.test/app/version.json" }), clock,
            NullLogger<AppVersionProvider>.Instance);
        Assert.Equal(10200, await provider.GetMinSupportedCodeAsync(default));
        http.Responder = _ => throw new HttpRequestException("giù");
        Assert.Equal(10200, await provider.GetMinSupportedCodeAsync(default)); // cache di 5 minuti
        Assert.Single(http.Requests);
        clock.Advance(TimeSpan.FromMinutes(6));
        Assert.Null(await provider.GetMinSupportedCodeAsync(default)); // irraggiungibile: controllo saltato

        var none = new AppVersionProvider(new SingleClientFactory(http), Options.Create(new AppOptions()), clock,
            NullLogger<AppVersionProvider>.Instance);
        Assert.Null(await none.GetMinSupportedCodeAsync(default));
    }

    private sealed class SingleClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }
}

/// <summary><c>/api/app/lookup</c>, <c>/search</c>, <c>/tmdb/{id}</c> con provider e TMDb finti.</summary>
public class LookupTests(AppFixture fx) : IClassFixture<AppFixture>, IAsyncLifetime
{
    private AppFactory F => fx.Factory;
    private TestDevice _dev = null!;

    public async Task InitializeAsync()
    {
        if (TestDb.BaseConnection is null) return;
        await F.ResetAsync();
        _dev = await F.PairAsync();
    }

    public Task DisposeAsync()
    {
        _dev?.Dispose();
        return Task.CompletedTask;
    }

    private async Task<(HttpStatusCode, JsonObject)> Get(string path)
    {
        using var c = F.AppClient();
        var res = await c.SendAsync(_dev.Request(HttpMethod.Get, path));
        var text = await res.Content.ReadAsStringAsync();
        return (res.StatusCode, text.Length > 0 ? (JsonObject)JsonNode.Parse(text)! : new JsonObject());
    }

    [DbFact]
    public async Task Lookup_trova_prodotto_candidati_e_bozza()
    {
        F.Barcodes.Products["8012345678901"] = "Il Padrino (DVD) [Edizione Speciale]";
        var (status, o) = await Get("/api/app/lookup?ean=8012345678901");
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal("8012345678901", o["ean"]!.GetValue<string>());
        Assert.Equal("Il Padrino (DVD) [Edizione Speciale]", o["productName"]!.GetValue<string>());
        var candidates = o["candidates"]!.AsArray();
        Assert.Equal(2, candidates.Count);
        Assert.Equal(238, candidates[0]!["tmdbId"]!.GetValue<int>());
        Assert.Equal("Il padrino", candidates[0]!["title"]!.GetValue<string>());
        Assert.Equal(1972, candidates[0]!["year"]!.GetValue<int>());
        Assert.Equal("https://image.tmdb.org/t/p/w185/padrino.jpg", candidates[0]!["posterUrl"]!.GetValue<string>());
        Assert.Null(candidates[1]!["posterUrl"]);
        var draft = o["draft"]!.AsObject();
        Assert.Equal("Il padrino", draft["title"]!.GetValue<string>());
        Assert.Equal(["Francis Ford Coppola"], draft["director"]!.AsArray().Select(n => n!.GetValue<string>()));
        Assert.Equal(238, o["tmdbId"]!.GetValue<int>());
        Assert.Equal("/padrino.jpg", o["posterPath"]!.GetValue<string>());
        Assert.Empty(o["possibleDuplicates"]!.AsArray());
        // TMDb interrogato in italiano, per l'Italia.
        Assert.Contains(F.Tmdb.Requests, u => u.Query.Contains("language=it-IT") && u.Query.Contains("region=IT"));
    }

    [DbFact]
    public async Task Lookup_EAN_sconosciuto_bozza_vuota_e_cache_24h()
    {
        var before = F.Barcodes.Calls;
        var (status, o) = await Get("/api/app/lookup?ean=0000000000017");
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Null(o["productName"]);
        Assert.Empty(o["draft"]!.AsObject());
        Assert.Empty(o["candidates"]!.AsArray());
        await Get("/api/app/lookup?ean=0000000000017");
        Assert.Equal(before + 1, F.Barcodes.Calls); // seconda volta dalla cache
    }

    [DbFact]
    public async Task Lookup_errore_del_provider_non_va_in_cache()
    {
        F.Barcodes.Fail = true;
        try
        {
            var (status, o) = await Get("/api/app/lookup?ean=0000000000024");
            Assert.Equal(HttpStatusCode.OK, status);
            Assert.Null(o["productName"]);
        }
        finally { F.Barcodes.Fail = false; }
        F.Barcodes.Products["0000000000024"] = "Il padrino DVD";
        var (_, again) = await Get("/api/app/lookup?ean=0000000000024");
        Assert.Equal("Il padrino DVD", again["productName"]!.GetValue<string>());
    }

    [DbFact]
    public async Task Lookup_trovato_viene_dalla_cache()
    {
        F.Barcodes.Products["0000000000031"] = "Il padrino [Blu-ray]";
        await Get("/api/app/lookup?ean=0000000000031");
        var calls = F.Barcodes.Calls;
        F.Barcodes.Products.Remove("0000000000031");
        var (_, o) = await Get("/api/app/lookup?ean=0000000000031");
        Assert.Equal("Il padrino [Blu-ray]", o["productName"]!.GetValue<string>());
        Assert.Equal(calls, F.Barcodes.Calls);
    }

    [DbFact]
    public async Task Lookup_segnala_i_possibili_duplicati()
    {
        // Film importato da Tellico, senza EAN né tmdb_id: stesso titolo + anno normalizzati.
        using var admin = F.Client("root", "user,admin");
        var res = await admin.PostAsync("/api/import/tellico", new StringContent(
            """{"fields":[],"movies":[{"id":7,"title":"Il Padrino!","year":"1972"}]}""",
            System.Text.Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        F.Barcodes.Products["0000000000048"] = "Il Padrino (DVD)";
        var (_, o) = await Get("/api/app/lookup?ean=0000000000048");
        var dup = Assert.Single(o["possibleDuplicates"]!.AsArray())!;
        Assert.Equal((7, "Il Padrino!", 1972), (dup["id"]!.GetValue<int>(), dup["title"]!.GetValue<string>(), dup["year"]!.GetValue<int>()));
    }

    [DbFact]
    public async Task Lookup_EAN_non_valido_400()
    {
        Assert.Equal(HttpStatusCode.BadRequest, (await Get("/api/app/lookup?ean=abc")).Item1);
        Assert.Equal(HttpStatusCode.BadRequest, (await Get("/api/app/lookup?ean=123")).Item1);
        Assert.Equal(HttpStatusCode.BadRequest, (await Get("/api/app/lookup")).Item1);
    }

    [DbFact]
    public async Task Search_e_tmdb()
    {
        var (status, o) = await Get("/api/app/search?q=padrino&year=1972");
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal(238, o["candidates"]![0]!["tmdbId"]!.GetValue<int>());
        Assert.Contains(F.Tmdb.Requests, u => u.Query.Contains("year=1972"));

        var (empty, e) = await Get("/api/app/search?q=inesistente");
        Assert.Equal(HttpStatusCode.OK, empty);
        Assert.Empty(e["candidates"]!.AsArray());

        Assert.Equal(HttpStatusCode.BadRequest, (await Get("/api/app/search?q=")).Item1);
        Assert.Equal(HttpStatusCode.BadRequest, (await Get("/api/app/search?q=x&year=abc")).Item1);

        var (ok, d) = await Get("/api/app/tmdb/238");
        Assert.Equal(HttpStatusCode.OK, ok);
        Assert.Equal(238, d["tmdbId"]!.GetValue<int>());
        Assert.Equal("Il padrino", d["draft"]!["title"]!.GetValue<string>());
        Assert.Equal("https://image.tmdb.org/t/p/w500/padrino.jpg", d["posterUrl"]!.GetValue<string>());
        Assert.Equal(HttpStatusCode.NotFound, (await Get("/api/app/tmdb/999")).Item1);
    }

    [DbFact]
    public async Task Lookup_e_search_richiedono_la_firma()
    {
        using var site = F.Client("alice");
        Assert.Equal(HttpStatusCode.Unauthorized, (await site.GetAsync("/api/app/lookup?ean=8012345678901")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await site.GetAsync("/api/app/search?q=padrino")).StatusCode);
    }
}

/// <summary>TMDb senza token: errore chiaro, nessun crash.</summary>
public class LookupWithoutTmdbTests : IDisposable
{
    private readonly AppFactory? _f;

    public LookupWithoutTmdbTests()
    {
        if (TestDb.BaseConnection is null) return;
        _f = new AppFactory();
        _f.Settings["Tmdb:ApiToken"] = "";
    }

    [DbFact]
    public async Task Search_e_tmdb_503_lookup_solo_dal_nome_prodotto()
    {
        using var dev = await _f!.PairAsync();
        using var c = _f.AppClient();
        var search = await c.SendAsync(dev.Request(HttpMethod.Get, "/api/app/search?q=padrino"));
        Assert.Equal(HttpStatusCode.ServiceUnavailable, search.StatusCode);
        Assert.Equal("application/problem+json", search.Content.Headers.ContentType?.MediaType);
        Assert.Contains("Tmdb__ApiToken", await search.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await c.SendAsync(dev.Request(HttpMethod.Get, "/api/app/tmdb/238"))).StatusCode);

        _f.Barcodes.Products["8012345678901"] = "Il Padrino (DVD) 1972";
        var lookup = await c.SendAsync(dev.Request(HttpMethod.Get, "/api/app/lookup?ean=8012345678901"));
        Assert.Equal(HttpStatusCode.OK, lookup.StatusCode);
        var o = JsonNode.Parse(await lookup.Content.ReadAsStringAsync())!;
        Assert.Equal("Il Padrino", o["draft"]!["title"]!.GetValue<string>());
        Assert.Equal("1972", o["draft"]!["year"]!.ToJsonString());
        Assert.Empty(o["candidates"]!.AsArray());
        Assert.False(o["tmdbAvailable"]!.GetValue<bool>());
        Assert.Empty(_f.Tmdb.Requests);
    }

    public void Dispose() => _f?.Dispose();
}
