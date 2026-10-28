import { Hero } from '@/components/home/hero';
import { HowItWorks, NowShowing, PromoBanner } from '@/components/home/home-sections';

export function HomePage() {
  return (
    <>
      <Hero />
      <PromoBanner />
      <NowShowing />
      <HowItWorks />
    </>
  );
}
