package com.orbbound.game;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Arrays;
import org.junit.Test;

public class LanFrameCodecTest {
    @Test public void sharedWindowsUtf8VectorUsesBytesAndBigEndian() throws Exception {
        byte[] expected = new byte[] { 0, 0, 0, 14, 123, 34, 110, 97, 109, 101, 34, 58, 34, (byte) 0xe7, (byte) 0x90, (byte) 0x83, 34, 125 };
        assertArrayEquals(expected, LanFrameCodec.encode("{\"name\":\"球\"}"));
        assertEquals("{\"name\":\"球\"}", LanFrameCodec.read(new ByteArrayInputStream(expected)));
    }

    @Test public void reconstructsEverySplitBoundaryAndCoalescedFrames() throws Exception {
        String first = "{\"name\":\"中文🟢\"}", second = "{\"next\":2}";
        ByteArrayOutputStream joined = new ByteArrayOutputStream();
        joined.write(LanFrameCodec.encode(first));
        joined.write(LanFrameCodec.encode(second));
        byte[] bytes = joined.toByteArray();
        for (int boundary = 1; boundary < bytes.length; boundary++) {
            final int split = boundary;
            InputStream fragmented = new ByteArrayInputStream(bytes) {
                @Override public synchronized int read(byte[] buffer, int offset, int length) {
                    return super.read(buffer, offset, Math.min(length, pos < split ? split - pos : 1));
                }
            };
            assertEquals(first, LanFrameCodec.read(fragmented));
            assertEquals(second, LanFrameCodec.read(fragmented));
            assertNull(LanFrameCodec.read(fragmented));
        }
    }

    @Test public void allowsExactly64KiBAndRejectsActualUtf8ByteOverflow() throws Exception {
        char[] chars = new char[65536];
        Arrays.fill(chars, 'a');
        String exact = new String(chars);
        assertEquals(exact, LanFrameCodec.read(new ByteArrayInputStream(LanFrameCodec.encode(exact))));
        fails(() -> LanFrameCodec.encode(exact + "a"));
        Arrays.fill(chars, '球');
        fails(() -> LanFrameCodec.encode(new String(chars)));
        fails(() -> LanFrameCodec.encode(""));
    }

    @Test public void rejectsUnsignedOversizeEmptyMalformedAndTruncatedFrames() throws Exception {
        for (byte[] input : new byte[][] {
            { (byte) 0xff, (byte) 0xff, (byte) 0xff, (byte) 0xff },
            { 0, 1, 0, 1 }, { 0, 0, 0, 0 }, { 0 }, { 0, 0, 0, 3, 123 },
            { 0, 0, 0, 2, (byte) 0xc3, 0x28 }
        }) fails(() -> LanFrameCodec.read(new ByteArrayInputStream(input)));
        fails(() -> LanFrameCodec.encode("\ud800"));
    }

    private interface Attempt { void run() throws IOException; }
    private static void fails(Attempt action) throws Exception {
        try { action.run(); fail("Expected invalid frame rejection"); } catch (IOException expected) { }
    }
}
