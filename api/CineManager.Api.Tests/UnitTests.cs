using System.Security.Claims;
using System.Text.Json.Nodes;
using CineManager.Api.Auth;
using CineManager.Api.Data;
using CineManager.Api.Import;

namespace CineManager.Api.Tests;

public class TitleNormalizerTests
{
    [Theory]
    [InlineData("Il Padrino", "il padrino")]
    [InlineData("  L'Âge d'or! ", "l age d or")]
    [InlineData("Amélie", "amelie")]
    [InlineData("Così è (se vi pare)", "cosi e se vi pare")]
    [InlineData("Ocean's Eleven: Fate il vostro gioco", "ocean s eleven fate il vostro gioco")]
    [InlineData("Straße", "strase")]
    [InlineData("", "")]
    [InlineData(null, "")]
    public void Normalizza(string? input, string expected) => Assert.Equal(expected, TitleNormalizer.Normalize(input));

    [Fact]
    public void Chiave_titolo_anno_accetta_anno_numerico_o_stringa()
    {
        var a = new JsonObject { ["title"] = "L'odio", ["year"] = 1995 };
        var b = new JsonObject { ["title"] = "l odio", ["year"] = "1995" };
        Assert.Equal(TitleNormalizer.Key(a), TitleNormalizer.Key(b));
        Assert.NotEqual(TitleNormalizer.Key(a), TitleNormalizer.Key(new JsonObject { ["title"] = "L'odio", ["year"] = 1996 }));
        Assert.Null(TitleNormalizer.Key(new JsonObject { ["year"] = 1995 }));
    }
}

public class EanNormalizerTests
{
    [Theory]
    [InlineData("8012345678901", "8012345678901")]
    [InlineData("801-2345 678901", "8012345678901")]
    [InlineData("012345678905", "0012345678905")] // UPC-A → EAN-13
    [InlineData("  ", null)]
    [InlineData("abc", null)]
    [InlineData(null, null)]
    public void Normalizza(string? input, string? expected) => Assert.Equal(expected, EanNormalizer.Normalize(input));
}

public class FieldTypeMappingTests
{
    [Theory]
    [InlineData("1", 0, FieldTypes.Line)]
    [InlineData("2", 0, FieldTypes.Para)]
    [InlineData("3", 0, FieldTypes.Choice)]
    [InlineData("4", 0, FieldTypes.Bool)]
    [InlineData("6", 0, FieldTypes.Number)]
    [InlineData("7", 0, FieldTypes.Url)]
    [InlineData("8", 0, FieldTypes.Table)]
    [InlineData("10", 0, FieldTypes.Image)]
    [InlineData("11", 0, FieldTypes.Dependent)]
    [InlineData("12", 0, FieldTypes.Date)]
    [InlineData("14", 0, FieldTypes.Rating)]
    [InlineData("1", 0x20, FieldTypes.Dependent)]
    [InlineData("6", 0x23, FieldTypes.Dependent)]
    [InlineData("5", 0, FieldTypes.Line)]
    [InlineData("99", 0, FieldTypes.Line)]
    [InlineData(null, 0, FieldTypes.Line)]
    public void Mappa_codici_Tellico(string? code, int flags, string expected) =>
        Assert.Equal(expected, TellicoFieldTypes.Map(code, flags));
}

public class RolesTests
{
    [Fact]
    public void Gruppo_utenti_vuoto_rende_tutti_utenti() =>
        Assert.Equal(["user"], Roles.Resolve([], null, "admins"));

    [Fact]
    public void Gruppo_utenti_richiesto() =>
        Assert.Empty(Roles.Resolve(["altri"], "cinema", "admins"));

    [Fact]
    public void Admin_richiede_anche_il_gruppo_utenti()
    {
        Assert.Equal(["user", "admin"], Roles.Resolve(["cinema", "admins"], "cinema", "admins"));
        Assert.Empty(Roles.Resolve(["admins"], "cinema", "admins"));
        Assert.Equal(["user", "admin"], Roles.Resolve(["admins"], "", "admins"));
    }

    [Fact]
    public void Gruppo_admin_vuoto_nessun_admin() =>
        Assert.Equal(["user"], Roles.Resolve(["cinema", "admins"], "cinema", ""));

    [Theory]
    [InlineData("user,admin", new[] { "user", "admin" })]
    [InlineData("admin", new[] { "user", "admin" })]
    [InlineData(" USER ", new[] { "user" })]
    [InlineData(null, new[] { "user" })]
    [InlineData("nessuno", new string[0])]
    public void Ruoli_di_sviluppo(string? input, string[] expected) =>
        Assert.Equal(expected, Roles.ParseDevRoles(input));

    [Fact]
    public void Gruppi_come_claim_multipli_o_array_json()
    {
        var p = new ClaimsPrincipal(new ClaimsIdentity([
            new Claim("groups", "cinema"), new Claim("groups", "[\"admins\",\"cinema\"]"),
        ]));
        Assert.Equal(["cinema", "admins"], AuthSetup.ReadGroups(p));
    }
}

public class LocalUrlTests
{
    [Theory]
    [InlineData("/", "/")]
    [InlineData("/?file=x", "/?file=x")]
    [InlineData("/intel#a", "/intel#a")]
    [InlineData("https://evil.example/", "/")]
    [InlineData("//evil.example/", "/")]
    [InlineData("/\\evil.example/", "/")]
    [InlineData("evil", "/")]
    [InlineData("/a\r\nSet-Cookie: x", "/")]
    [InlineData("", "/")]
    [InlineData(null, "/")]
    public void Solo_percorsi_locali(string? input, string expected) => Assert.Equal(expected, LocalUrl.Sanitize(input));
}

public class CoverNameTests
{
    [Theory]
    [InlineData("abc123.jpeg", true)]
    [InlineData("a_b-c.PNG", true)]
    [InlineData("..", false)]
    [InlineData(".hidden", false)]
    [InlineData("../x.jpg", false)]
    [InlineData("sub/x.jpg", false)]
    [InlineData("x y.jpg", false)]
    [InlineData("", false)]
    public void Nome_file_sanificato(string name, bool ok) => Assert.Equal(ok, CoverStore.IsSafeName(name));
}

public class SnakeCaseTests
{
    [Theory]
    [InlineData("TellicoId", "tellico_id")]
    [InlineData("PK_Movies", "pk_movies")]
    [InlineData("CreatedByDevice", "created_by_device")]
    public void Converte(string input, string expected) => Assert.Equal(expected, CinemaDbContext.ToSnake(input));
}
