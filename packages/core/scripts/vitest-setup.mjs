// テスト由来の判定ログが実使用ディレクトリ（~/.jev/logs）に混入するのを防ぐ
// （docs/05「実運用とテストの分離」。#46）。fileSink は JEV_LOG_DIR を既定より
// 先に読むため、テスト中の judge() はすべてこのテスト専用ディレクトリに書く。
// クリーンアップはしない（OS の tmp 掃除に任せる。テスト単位の rm は sink が
// 同一ディレクトリに書くテスト間で競い得るため入れない）
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JEV_LOG_DIR = mkdtempSync(join(tmpdir(), "jev-test-logs-"));
