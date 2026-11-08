using System;
using System.Collections.Generic;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace CineManager.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class Initial : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateSequence<int>(
                name: "movies_app_id_seq",
                startValue: 1000000L);

            migrationBuilder.CreateTable(
                name: "collection_fields",
                columns: table => new
                {
                    name = table.Column<string>(type: "text", nullable: false),
                    title = table.Column<string>(type: "text", nullable: false),
                    type = table.Column<string>(type: "text", nullable: false),
                    multiple = table.Column<bool>(type: "boolean", nullable: false),
                    allowed = table.Column<List<string>>(type: "text[]", nullable: true),
                    origin = table.Column<string>(type: "text", nullable: false),
                    groupable = table.Column<bool>(type: "boolean", nullable: false),
                    group_min_size = table.Column<int>(type: "integer", nullable: false),
                    in_form = table.Column<bool>(type: "boolean", nullable: false),
                    ordinal = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_collection_fields", x => x.name);
                    table.CheckConstraint("ck_collection_fields_origin", "origin IN ('tellico', 'local')");
                });

            migrationBuilder.CreateTable(
                name: "data_protection_keys",
                columns: table => new
                {
                    id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    friendly_name = table.Column<string>(type: "text", nullable: true),
                    xml = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_data_protection_keys", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "ean_lookup_cache",
                columns: table => new
                {
                    ean = table.Column<string>(type: "text", nullable: false),
                    provider = table.Column<string>(type: "text", nullable: false),
                    response = table.Column<string>(type: "jsonb", nullable: false),
                    fetched_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_ean_lookup_cache", x => x.ean);
                });

            migrationBuilder.CreateTable(
                name: "users",
                columns: table => new
                {
                    sub = table.Column<string>(type: "text", nullable: false),
                    username = table.Column<string>(type: "text", nullable: false),
                    display_name = table.Column<string>(type: "text", nullable: true),
                    groups = table.Column<List<string>>(type: "text[]", nullable: false),
                    last_login_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    security_stamp = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_users", x => x.sub);
                });

            migrationBuilder.CreateTable(
                name: "devices",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_sub = table.Column<string>(type: "text", nullable: false),
                    name = table.Column<string>(type: "text", nullable: false),
                    public_key = table.Column<byte[]>(type: "bytea", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    last_seen_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    revoked_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_devices", x => x.id);
                    table.ForeignKey(
                        name: "fk_devices_users_user_sub",
                        column: x => x.user_sub,
                        principalTable: "users",
                        principalColumn: "sub",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "pairing_codes",
                columns: table => new
                {
                    code_hash = table.Column<byte[]>(type: "bytea", nullable: false),
                    user_sub = table.Column<string>(type: "text", nullable: false),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    used_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_pairing_codes", x => x.code_hash);
                    table.ForeignKey(
                        name: "fk_pairing_codes_users_user_sub",
                        column: x => x.user_sub,
                        principalTable: "users",
                        principalColumn: "sub",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "movies",
                columns: table => new
                {
                    id = table.Column<int>(type: "integer", nullable: false),
                    tellico_id = table.Column<int>(type: "integer", nullable: true),
                    ean = table.Column<string>(type: "text", nullable: true),
                    data = table.Column<string>(type: "jsonb", nullable: false),
                    source = table.Column<string>(type: "text", nullable: false),
                    tmdb_id = table.Column<int>(type: "integer", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_by = table.Column<string>(type: "text", nullable: true),
                    created_by_device = table.Column<Guid>(type: "uuid", nullable: true),
                    exported_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_movies", x => x.id);
                    table.CheckConstraint("ck_movies_source", "source IN ('tellico', 'app')");
                    table.ForeignKey(
                        name: "fk_movies_devices_created_by_device",
                        column: x => x.created_by_device,
                        principalTable: "devices",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "fk_movies_users_created_by",
                        column: x => x.created_by,
                        principalTable: "users",
                        principalColumn: "sub",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "user_movie_state",
                columns: table => new
                {
                    user_sub = table.Column<string>(type: "text", nullable: false),
                    movie_id = table.Column<int>(type: "integer", nullable: false),
                    status = table.Column<string>(type: "text", nullable: true),
                    rating = table.Column<short>(type: "smallint", nullable: true),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_movie_state", x => new { x.user_sub, x.movie_id });
                    table.CheckConstraint("ck_user_movie_state_not_empty", "status IS NOT NULL OR rating IS NOT NULL");
                    table.CheckConstraint("ck_user_movie_state_rating", "rating IS NULL OR rating BETWEEN 1 AND 5");
                    table.CheckConstraint("ck_user_movie_state_status", "status IS NULL OR status IN ('seen', 'watchlist')");
                    table.ForeignKey(
                        name: "fk_user_movie_state_movies_movie_id",
                        column: x => x.movie_id,
                        principalTable: "movies",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_user_movie_state_users_user_sub",
                        column: x => x.user_sub,
                        principalTable: "users",
                        principalColumn: "sub",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_devices_user_sub",
                table: "devices",
                column: "user_sub");

            migrationBuilder.CreateIndex(
                name: "ix_movies_created_by",
                table: "movies",
                column: "created_by");

            migrationBuilder.CreateIndex(
                name: "ix_movies_created_by_device",
                table: "movies",
                column: "created_by_device");

            migrationBuilder.CreateIndex(
                name: "ix_movies_ean",
                table: "movies",
                column: "ean",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_movies_tellico_id",
                table: "movies",
                column: "tellico_id",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_pairing_codes_expires_at",
                table: "pairing_codes",
                column: "expires_at");

            migrationBuilder.CreateIndex(
                name: "ix_pairing_codes_user_sub",
                table: "pairing_codes",
                column: "user_sub");

            migrationBuilder.CreateIndex(
                name: "ix_user_movie_state_movie_id",
                table: "user_movie_state",
                column: "movie_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "collection_fields");

            migrationBuilder.DropTable(
                name: "data_protection_keys");

            migrationBuilder.DropTable(
                name: "ean_lookup_cache");

            migrationBuilder.DropTable(
                name: "pairing_codes");

            migrationBuilder.DropTable(
                name: "user_movie_state");

            migrationBuilder.DropTable(
                name: "movies");

            migrationBuilder.DropTable(
                name: "devices");

            migrationBuilder.DropTable(
                name: "users");

            migrationBuilder.DropSequence(
                name: "movies_app_id_seq");
        }
    }
}
