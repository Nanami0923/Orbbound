package com.orbbound.game;

import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

/** The same wire format as Windows: four unsigned big-endian bytes, then strict UTF-8. */
public final class LanFrameCodec {
    public static final int MAX_MESSAGE_BYTES = 65536;

    private LanFrameCodec() {}

    public static byte[] encode(String message) throws IOException {
        if (message == null) throw new IOException("INVALID_MESSAGE");
        byte[] payload;
        try {
            ByteBuffer encoded = StandardCharsets.UTF_8.newEncoder()
                .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                .encode(java.nio.CharBuffer.wrap(message));
            payload = new byte[encoded.remaining()];
            encoded.get(payload);
        } catch (CharacterCodingException error) { throw new IOException("INVALID_UTF8", error); }
        int size = payload.length;
        if (size < 1 || size > MAX_MESSAGE_BYTES) throw new IOException("MESSAGE_TOO_LARGE");
        byte[] frame = new byte[size + 4];
        frame[0] = (byte) (size >>> 24);
        frame[1] = (byte) (size >>> 16);
        frame[2] = (byte) (size >>> 8);
        frame[3] = (byte) size;
        System.arraycopy(payload, 0, frame, 4, size);
        return frame;
    }

    /** Returns null only for an orderly EOF before the next frame starts. */
    public static String read(InputStream input) throws IOException {
        return read(input, null);
    }

    static String read(InputStream input, Runnable frameStarted) throws IOException {
        int first = input.read();
        if (first < 0) return null;
        if (frameStarted != null) frameStarted.run();
        byte[] header = new byte[3];
        readFully(input, header);
        long size = ((long) first << 24) | ((long) (header[0] & 255) << 16)
            | ((long) (header[1] & 255) << 8) | (header[2] & 255);
        if (size < 1 || size > MAX_MESSAGE_BYTES) throw new IOException("INVALID_FRAME_SIZE");
        byte[] payload = new byte[(int) size];
        readFully(input, payload);
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(payload)).toString();
        } catch (CharacterCodingException error) { throw new IOException("INVALID_UTF8", error); }
    }

    private static void readFully(InputStream input, byte[] buffer) throws IOException {
        int offset = 0;
        while (offset < buffer.length) {
            int count = input.read(buffer, offset, buffer.length - offset);
            if (count < 0) throw new EOFException("TRUNCATED_FRAME");
            if (count == 0) continue;
            offset += count;
        }
    }
}
