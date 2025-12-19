interface HomeProps {
    signOut?: () => void;
    user?: any;
}
export default function Home({ signOut, user }: HomeProps): import("react").JSX.Element;
export {};
