using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using CineManager.Api.Devices;
using CineManager.Api.Lookup;
using CineManager.Api.Movies;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace CineManager.Api.Tests.Support;

/// <summary>Provider di codici a barre finto (nome <c>fake</c>): EAN → nome prodotto.</summary>
public sealed class FakeBarcodeProvider : IBarcodeProvider
{
    public Dictionary<string, string> Products { get; } = new();
    public bool Fail { get; set; }
    public int Calls;

    public string Name => "fake";

    public Task<BarcodeProviderResult> LookupAsync(string ean, CancellationToken ct)
    {
        Interlocked.Increment(ref Calls);
        if (Fail) throw new BarcodeProviderException("provider finto in errore");
        return Task.FromResult(Products.TryGetValue(ean, out var p) ? new BarcodeProviderResult(p) : BarcodeProviderResult.NotFound);
    }
}

/// <summary>
/// Host per gli endpoint della fase 3: TMDb, copertine, version.json e provider EAN finti
/// (nessuna rete), rate limit alti tranne dove un test li abbassa.
/// </summary>
public class AppFactory : ApiFactory
{
    public const string VersionUrl = "http://web.test/app/version.json";
    public const int MinSupportedCode = 10000;

    public FakeHttp Tmdb { get; } = new();
    public FakeHttp Covers { get; } = new();
    public FakeHttp Version { get; } = new()
    {
        Responder = _ => FakeHttp.Json($$"""{"version":"1.0.0","versionCode":10300,"minSupportedCode":{{MinSupportedCode}}}"""),
    };
    public FakeBarcodeProvider Barcodes { get; } = new();

    public AppFactory()
    {
        Settings["RateLimit:PairPerIp"] = "100000";
        Settings["RateLimit:PairGlobal"] = "100000";
        Settings["RateLimit:LookupPerDevice"] = "100000";
        Settings["Tmdb:ApiToken"] = "token-di-test";
        Settings["Lookup:Providers"] = "fake";
        Settings["App:VersionUrl"] = VersionUrl;
        Settings["PublicBaseUrl"] = "https://cinema.example.test";
        TmdbFixtures.Install(Tmdb);
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.ConfigureTestServices(s =>
        {
            s.AddHttpClient<TmdbClient>().ConfigurePrimaryHttpMessageHandler(() => Tmdb);
            s.AddHttpClient<CoverDownloader>().ConfigurePrimaryHttpMessageHandler(() => Covers);
            s.AddHttpClient(AppVersionProvider.HttpClientName).ConfigurePrimaryHttpMessageHandler(() => Version);
            s.AddSingleton<IBarcodeProvider>(Barcodes);
        });
    }

    /// <summary>Abbina un nuovo telefono a <paramref name="user"/> passando dal sito, come l'app.</summary>
    public async Task<TestDevice> PairAsync(string user = "alice", string name = "Pixel di prova")
    {
        using var site = Client(user);
        var pairing = await site.PostAsync("/api/pairing", null);
        pairing.EnsureSuccessStatusCode();
        var code = (await pairing.Content.ReadFromJsonAsync<JsonObject>())!["code"]!.GetValue<string>();
        var device = new TestDevice();
        using var anon = Client(user: null, csrf: false);
        var res = await anon.PostAsJsonAsync("/api/app/pair",
            new { code, deviceName = name, publicKey = device.PublicKey, proof = device.Proof(code) });
        if (res.StatusCode != HttpStatusCode.OK)
            throw new InvalidOperationException("pair: " + res.StatusCode + " " + await res.Content.ReadAsStringAsync());
        device.Id = Guid.Parse((await res.Content.ReadFromJsonAsync<JsonObject>())!["deviceId"]!.GetValue<string>());
        return device;
    }

    /// <summary>Client anonimo per le richieste firmate (nessun header del sito).</summary>
    public HttpClient AppClient() => Client(user: null, csrf: false);
}

/// <summary>Fixture di classe per <see cref="AppFactory"/>.</summary>
public sealed class AppFixture : IDisposable
{
    private readonly Lazy<AppFactory> _factory = new(() =>
    {
        var f = new AppFactory();
        f.CreateClient().Dispose();
        return f;
    });

    public AppFactory Factory => _factory.Value;

    public void Dispose()
    {
        if (_factory.IsValueCreated) _factory.Value.Dispose();
    }
}

/// <summary>Risposte TMDb registrate (ridotte) per "Il padrino".</summary>
public static class TmdbFixtures
{
    public const string SearchGodfather = """
        { "page": 1, "results": [
          { "id": 238, "title": "Il padrino", "original_title": "The Godfather", "release_date": "1972-03-14", "poster_path": "/padrino.jpg" },
          { "id": 240, "title": "Il padrino - Parte II", "original_title": "The Godfather Part II", "release_date": "1974-12-20", "poster_path": null }
        ], "total_results": 2 }
        """;

    public const string Godfather = """
        { "id": 238, "title": "Il padrino", "original_title": "The Godfather", "release_date": "1972-03-14",
          "runtime": 175, "overview": "Don Vito Corleone...", "poster_path": "/padrino.jpg",
          "genres": [ { "id": 18, "name": "Dramma" }, { "id": 80, "name": "Crime" } ],
          "production_countries": [ { "iso_3166_1": "US", "name": "United States of America" } ],
          "spoken_languages": [ { "iso_639_1": "en", "english_name": "English", "name": "English" },
                                { "iso_639_1": "it", "english_name": "Italian", "name": "Italiano" },
                                { "iso_639_1": "la", "english_name": "Latin", "name": "Latin" } ],
          "credits": {
            "cast": [ { "name": "Al Pacino", "character": "Michael Corleone", "order": 1 },
                      { "name": "Marlon Brando", "character": "Don Vito Corleone", "order": 0 } ],
            "crew": [ { "name": "Francis Ford Coppola", "job": "Director" },
                      { "name": "Mario Puzo", "job": "Screenplay" } ] } }
        """;

    /// <summary>search/movie risponde per "padrino", movie/238 con i dettagli, il resto 404.</summary>
    public static void Install(FakeHttp http) => http.Responder = req =>
    {
        var uri = req.RequestUri!;
        if (req.Headers.Authorization?.Parameter != "token-di-test") return FakeHttp.Json("{}", HttpStatusCode.Unauthorized);
        if (uri.AbsolutePath.EndsWith("/search/movie", StringComparison.Ordinal))
            return FakeHttp.Json(Uri.UnescapeDataString(uri.Query).Contains("padrino", StringComparison.OrdinalIgnoreCase)
                ? SearchGodfather : """{"page":1,"results":[]}""");
        if (uri.AbsolutePath.EndsWith("/movie/238", StringComparison.Ordinal)) return FakeHttp.Json(Godfather);
        return FakeHttp.Json("""{"status_code":34}""", HttpStatusCode.NotFound);
    };

    /// <summary>JPEG minimo valido per il controllo della firma del file.</summary>
    public static byte[] Jpeg(int size = 64)
    {
        var b = new byte[size];
        b[0] = 0xFF; b[1] = 0xD8; b[2] = 0xFF; b[3] = 0xE0;
        Encoding.ASCII.GetBytes("JFIF").CopyTo(b, 6);
        return b;
    }
}
