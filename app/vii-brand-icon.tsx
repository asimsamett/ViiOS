import Image from 'next/image';
import { publicAsset } from '@/lib/public-mode';
import './vii-brand-icon.css';

/** Shared ViiOS mark; surrounding labels usually provide the accessible name. */
export default function ViiBrandIcon({ className = '', alt = '' }: { className?: string; alt?: string }) {
  return <Image
    className={`vii-brand-icon ${className}`.trim()}
    src={publicAsset('/brand/viios-mark.png')}
    width={512}
    height={512}
    alt={alt}
    aria-hidden={alt ? undefined : true}
    draggable={false}
    decoding="async"
    loading="eager"
    unoptimized
  />;
}
