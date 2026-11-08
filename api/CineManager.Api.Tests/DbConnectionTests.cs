using CineManager.Api.Infrastructure;
using Microsoft.Extensions.Configuration;
using Npgsql;
using Xunit;

namespace CineManager.Api.Tests;

public class DbConnectionTests
{
    private static IConfiguration Config(params (string Key, string? Value)[] pairs) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(pairs.Select(p => new KeyValuePair<string, string?>(p.Key, p.Value)))
            .Build();

    [Fact]
    public void Password_con_caratteri_speciali_resta_intatta()
    {
        const string pwd = "p;a=s's\"w$ord ";
        var cs = DbConnection.WithPassword("Host=db;Database=cinema;Username=cinema", pwd);
        var parsed = new NpgsqlConnectionStringBuilder(cs);
        Assert.Equal(pwd, parsed.Password);
        Assert.Equal("db", parsed.Host);
        Assert.Equal("cinema", parsed.Database);
    }

    [Fact]
    public void Database_Password_ha_la_precedenza_su_POSTGRES_PASSWORD()
    {
        var c = Config(("ConnectionStrings:Cinema", "Host=db;Username=cinema"),
                       ("Database:Password", "a"), ("POSTGRES_PASSWORD", "b"));
        Assert.Equal("a", new NpgsqlConnectionStringBuilder(DbConnection.Build(c)).Password);
    }

    [Fact]
    public void Usa_POSTGRES_PASSWORD_se_manca_Database_Password()
    {
        var c = Config(("ConnectionStrings:Cinema", "Host=db;Username=cinema"), ("POSTGRES_PASSWORD", "b"));
        Assert.Equal("b", new NpgsqlConnectionStringBuilder(DbConnection.Build(c)).Password);
    }

    [Fact]
    public void Senza_password_esterna_la_stringa_resta_invariata()
    {
        var c = Config(("ConnectionStrings:Cinema", "Host=db;Username=cinema;Password=x"));
        Assert.Equal("x", new NpgsqlConnectionStringBuilder(DbConnection.Build(c)).Password);
    }

    [Fact]
    public void Connection_string_mancante_e_un_errore()
    {
        Assert.Throws<InvalidOperationException>(() => DbConnection.Build(Config()));
    }
}
