package com.orbbound.game;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class BackupDocumentsTest {
    @Test public void utf8RoundTripAndBom() throws Exception {
        String text = "{\"app\":\"orbbound\",\"note\":\"存档与星级\"}";
        assertEquals(text, BackupDocuments.read(new ByteArrayInputStream(BackupDocuments.encode(text))));
        assertEquals(text, BackupDocuments.read(new ByteArrayInputStream(("\uFEFF" + text).getBytes(StandardCharsets.UTF_8))));
    }

    @Test public void limitsActualBytesRatherThanCharacterCount() throws Exception {
        byte[] exact = new byte[BackupDocuments.MAX_BYTES];
        java.util.Arrays.fill(exact, (byte) ' ');
        assertEquals(BackupDocuments.MAX_BYTES, BackupDocuments.read(new ByteArrayInputStream(exact)).length());
        expectFailure(() -> BackupDocuments.read(new ByteArrayInputStream(new byte[BackupDocuments.MAX_BYTES + 1])));
        expectFailure(() -> BackupDocuments.encode(new String(new char[700000]).replace('\0', '球')));
    }

    @Test public void rejectsMalformedUtf8AndEmptyDocuments() throws Exception {
        expectFailure(() -> BackupDocuments.read(new ByteArrayInputStream(new byte[] { (byte) 0xc3, 0x28 })));
        expectFailure(() -> BackupDocuments.read(new ByteArrayInputStream(new byte[0])));
        expectFailure(() -> BackupDocuments.encode(""));
    }

    @Test public void fileNamesCannotContainPathSeparatorsOrControlCharacters() {
        String name = BackupDocuments.fileName("../备份\\档案\n");
        assertTrue(name.endsWith(".json"));
        assertFalse(name.contains("/")); assertFalse(name.contains("\\")); assertFalse(name.contains("\n"));
        assertEquals("Orbbound-backup.json", BackupDocuments.fileName(".."));
        assertEquals("save.JSON", BackupDocuments.fileName("save.JSON"));
    }

    private interface Attempt { void run() throws IOException; }
    private static void expectFailure(Attempt attempt) throws Exception {
        try { attempt.run(); fail("Expected bounded document I/O failure"); } catch (IOException expected) { }
    }
}
