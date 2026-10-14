package com.orbbound.game;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

/** Bounded document I/O; the shared frontend remains the backup schema authority. */
final class BackupDocuments {
    static final int MAX_BYTES = 2_000_000;

    static byte[] encode(String text) throws IOException {
        if (text == null || text.isEmpty()) throw new IOException("备份内容为空");
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BYTES) throw new IOException("备份文件超过 2 MB");
        return bytes;
    }

    static String read(InputStream input) throws IOException {
        if (input == null) throw new IOException("无法读取所选文件");
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (count == 0) continue;
            if (output.size() > MAX_BYTES - count) throw new IOException("备份文件超过 2 MB");
            output.write(buffer, 0, count);
        }
        if (output.size() == 0) throw new IOException("备份文件为空");
        try {
            String text = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(output.toByteArray())).toString();
            return text.startsWith("\uFEFF") ? text.substring(1) : text;
        } catch (CharacterCodingException error) {
            throw new IOException("请选择 UTF-8 编码的 JSON 备份", error);
        }
    }

    static String fileName(String requested) {
        String name = requested == null ? "Orbbound-backup" : requested.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "-").trim();
        if (name.isEmpty() || name.equals(".") || name.equals("..")) name = "Orbbound-backup";
        if (name.length() > 100) name = name.substring(0, 100);
        if (!name.toLowerCase(java.util.Locale.ROOT).endsWith(".json")) name += ".json";
        return name;
    }
}
