export class SerializedWriter<T> {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly writeNow: (value: T) => Promise<void>) {}

  write(value: T, shouldWrite: () => boolean = () => true): Promise<void> {
    const write = this.tail.then(async () => {
      if (!shouldWrite()) return;
      await this.writeNow(value);
    });
    this.tail = write.catch(() => {});
    return write;
  }
}
