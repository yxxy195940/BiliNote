import sys
import glob

def clear_execstack(filename):
    with open(filename, 'rb+') as f:
        data = bytearray(f.read())
        if data[:4] != b'\x7fELF':
            return
        # 64-bit ELF
        e_phoff = int.from_bytes(data[32:40], 'little')
        e_phentsize = int.from_bytes(data[54:56], 'little')
        e_phnum = int.from_bytes(data[56:58], 'little')
        for i in range(e_phnum):
            ph_offset = e_phoff + i * e_phentsize
            p_type = int.from_bytes(data[ph_offset:ph_offset+4], 'little')
            if p_type == 0x6474e551:  # PT_GNU_STACK
                p_flags = int.from_bytes(data[ph_offset+4:ph_offset+8], 'little')
                p_flags &= ~1  # Clear executable flag
                data[ph_offset+4:ph_offset+8] = p_flags.to_bytes(4, 'little')
                f.seek(0)
                f.write(data)
                print(f'Cleared execstack on {filename}')

for f in glob.glob('/usr/local/lib/python3.11/site-packages/ctranslate2*/**/*.so*', recursive=True):
    clear_execstack(f)
